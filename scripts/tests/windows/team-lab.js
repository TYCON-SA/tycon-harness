'use strict';
/**
 * team-lab.js — lo que comparten los dos ensayos de la instalación DEL EQUIPO en Windows: el alta de un dev nuevo
 * (`onboarding-probe.js`) y la máquina del viernes que se actualiza a lo de hoy (`update-probe.js`). Story 8.17, W0.
 *
 * POR QUÉ EXISTE. El escenario `measure` instala la copia pública (un repo, una línea). El equipo se instala distinto:
 * dos repos internos y un texto (`onboarding/new-dev-harness-setup.md`) que el dev le pega al asistente, con una rama
 * de pasos para Windows. Todos los devs del equipo están en Windows y esa rama nunca corrió en uno. Acá vive lo que
 * hace falta para ensayarla sin una persona y sin una credencial:
 *   · LAS DOS FORMAS DEL TEXTO. El texto del alta se lee del commit que se ensaya, y tiene una de dos formas: la de DOS
 *     CLONES (el arnés y agent-skills; los enlaces, el import y la línea de arranque se hacen a mano) o la de UN SOLO
 *     CLON (el repo trae `skills/` y `agents/` en su raíz, y `harness.js install` deja los enlaces, el import, la
 *     línea de arranque y los hooks). `parseTeamDoc` dice cuál leyó (`shape`) y todo lo demás depende de eso: con un
 *     clon, la carpeta de las skills ES el clon y no hay un segundo repo que clonar, fotografiar ni actualizar.
 *   · LOS REMOTOS DEL LABORATORIO. Los dos bundles de `build-sources.js` se vuelven dos repos sin árbol de trabajo
 *     dentro del laboratorio. Su rama `main` se apunta al commit del viernes o al de hoy: así un clon del laboratorio
 *     «trae una versión nueva» con su `git fetch` de siempre, sin red.
 *   · EL TEXTO DEL ALTA, TAL CUAL. Los bloques `powershell` de la rama de Windows se sacan del texto del commit que se
 *     ensaya y se corren sin cambiarles una letra, con el PowerShell que tenga la variante (`pwsh` 7 o el `powershell`
 *     5.1 que trae Windows). Las direcciones de los repos que el texto nombra se sirven desde los remotos del
 *     laboratorio (un desvío de git por variables de ambiente). Lo que pide una persona, una credencial o una
 *     herramienta opcional no se corre: queda en la lista «no ensayado», con su motivo.
 *   · LA FOTO de una carpeta de usuario: `settings.json` (y cómo está escrito: marca de orden de bytes, finales de
 *     línea, sangría), cada hook con su archivo (¿existe?), la línea de arranque, `doctor --json`, `version`, los
 *     enlaces, `~/.claude/commands/`, la rama y el commit de cada clon, y los hooks contra la lista del instalador.
 *   · UNA SESIÓN QUE ARRANCA: todos los hooks `SessionStart`, con su `command` tal como quedó registrado.
 *   · LA COMPARACIÓN de dos fotos. Cada diferencia sale con su gravedad: «rompe el trabajo del dev», «pierde un
 *     control» o «ruido». La gravedad la decide una tabla de este archivo, no quien lee el reporte.
 *
 * Nunca la carpeta de usuario real: toda carpeta de usuario pasa por `lab.labHomeProblem`. Sin dependencias.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lab.js');
const C = require('./count-hooks.js');
const F = require('./fire-registered.js');

const STATE_FILE = 'rehearsal-state.json';
const DOC = 'onboarding/new-dev-harness-setup.md';
const STEP_ZERO = 'onboarding/step-0-windows.md';
const KNOWN_LINES = 'scripts/tests/fixtures/startup-lines.json';
const PLACE = require('../../setup/harness/place.js');
// el lugar del arnés y el nombre viejo (story 8.19): se mira el que esté. Una máquina nueva sólo tiene el lugar; una de
// antes de la 8.19 (la del viernes), sólo el viejo. Falta el arnés sólo si no está ninguno, y entonces se nombra el lugar.
const LINK_NAMES = [PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME, 'agent-skills', 'agents', 'skills'];
const placeNames = (home) => { const has = (n) => { try { fs.lstatSync(path.join(home, '.claude', n)); return true; } catch (_) { return false; } }; return has(PLACE.LEGACY_PLACE_NAME) && !has(PLACE.PLACE_NAME) ? new Set([PLACE.PLACE_NAME]) : new Set([PLACE.LEGACY_PLACE_NAME]); };
const IMPORT_RX = new RegExp(`^@.*(?:${PLACE.PLACE_NAME}|${PLACE.LEGACY_PLACE_NAME}).*(?:INDEX|README)\\.md\\s*$`);   // el índice: INDEX.md desde 2026-10-14 (antes README.md)
// las dos formas del texto del alta (ver la cabecera)
const SHAPE = Object.freeze({ two: 'two-clones', one: 'one-clone', none: 'no-clone' });
const SHAPE_TEXT = Object.freeze({ 'two-clones': 'dos clones', 'one-clone': 'un solo clon', 'no-clone': 'sin clon (la versión instalada por la portada, story 8.23 E)' });
const SEVERITY = Object.freeze({ breaks: 'breaks', loses: 'loses-control', noise: 'noise' });
const SEVERITY_TEXT = Object.freeze({ breaks: 'rompe el trabajo del dev', 'loses-control': 'pierde un control', noise: 'ruido' });
const SEVERITY_ORDER = ['breaks', 'loses-control', 'noise'];
const BLOCK_TIMEOUT_MS = 20 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 10 * 60 * 1000;
const HOOK_TIMEOUT_MS = 60 * 1000;
// Lo que el alta pide y este ensayo no hace, con su motivo. Va entero al reporte.
const NOT_REHEARSED = Object.freeze([
  { step: 'PASO 0', what: 'instalar un requisito que falte (git, node, Go)', why: 'lo decide una persona; el ensayo sólo anota qué hay en la máquina' },
  { step: 'PASO 1', what: 'las credenciales de Azure DevOps y Git Credential Manager', why: 'piden una credencial: los dos repos se sirven desde el laboratorio' },
  { step: 'PASO 5', what: 'engram: instalar el binario, `engram setup claude-code` y su hook de commit', why: 'herramienta opcional que instala paquetes en la máquina (Go, winget)' },
  { step: 'PASO 5', what: 'el chequeo de versión de engram y la instalación de sqlite3 que corre el instalador', why: 'instalan paquetes: se corren apagados (TYCON_NO_ENGRAM_VERSION_CHECK=1, TYCON_SQLITE_AUTO_INSTALL=0)' },
  { step: 'PASO 6', what: 'el runtime de BMAD (`npx bmad-method install`)', why: 'es un asistente interactivo: sus respuestas las da una persona' },
  { step: 'PASO 7', what: 'Clockify, CodeGraph, instinct-mining y el lado Codex', why: 'opcionales por dev; Clockify pide una llave personal' },
  { step: 'PASO 8', what: 'el modo «bypass permissions»', why: 'se diagnostica sobre la aplicación del asistente, que el agente no tiene' },
  { step: 'PASO 9', what: 'las líneas de engram y de BMAD de la verificación final', why: 'verifican lo que no se instaló' },
  { step: 'PASO 9', what: 'reiniciar el asistente y preguntarle qué guías y revisores ve', why: 'pide una sesión real del asistente' },
  { step: 'instalador', what: 'el refresco de la lista de proyectos de Azure DevOps', why: 'llama a Azure con la sesión del dev: se corre apagado (TYCON_NO_AZ_PROJECTS_REFRESH=1)' },
]);
/** Lo no ensayado, dicho para la forma del texto que se leyó: con un solo clon no hay «dos repos» que servir. */
function notRehearsed(shape) {
  if (shape !== SHAPE.one) return NOT_REHEARSED;
  return NOT_REHEARSED.map((n) => (n.step === 'PASO 1' ? Object.assign({}, n, { why: 'piden una credencial: el repo se sirve desde el laboratorio' }) : n));
}
// Lo que acompaña a toda corrida del ensayo, además de lo de `lab.SAFE_ENV`.
const REHEARSAL_ENV = Object.freeze({
  GCM_INTERACTIVE: 'never',
  TYCON_NO_ENGRAM_VERSION_CHECK: '1',
  TYCON_SQLITE_AUTO_INSTALL: '0',
  TYCON_NO_AZ_PROJECTS_REFRESH: '1',
  TYCON_THIRD_PARTY_NETWORK_BUDGET_S: '60',
});

/** De una salida de error, la línea que dice qué pasó (no la primera, que suele ser la ubicación en el código). */
function tellingLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error|cannot|not recognized|no such|not found|denied|falta|no se |✗|⛔/i.test(l)) || lines[0] || '';
}
const sha = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (_) { return null; } };
const lastLines = (s, n = 3) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ');
const git = (dir, args, { env, cap = 20000, timeoutMs = 5 * 60 * 1000 } = {}) => L.run('git', ['-C', dir, ...args], { env, cap, timeoutMs });

/** Lee un JSON aunque traiga la marca de orden de bytes: `{ value, bom }`. Tira si no es JSON. */
function readJsonLoose(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const bom = raw.charCodeAt(0) === 0xfeff;
  return { value: JSON.parse(bom ? raw.slice(1) : raw), bom, raw };
}

// ── los remotos del laboratorio ──────────────────────────────────────────────────────────────────────────────────

/**
 * Vuelve los dos bundles dos repos sin árbol de trabajo en `<lab>/remotes/` y deja el estado del ensayo.
 * `{ ok, reason, state }`. `state.remotes.<harness|skills>` = `{ dir, friday, target, base }` (`base`: el «antes» del
 * escenario `portable`; `null` con un bundle que no lo trae).
 * Con un solo repo (`build-sources.js --single-repo`) hay un solo bundle: `state.remotes` trae sólo `harness`,
 * `state.single_repo` lo dice, y `friday` es `null` si no se pasó una marca.
 */
function makeRemotes({ lab, sources, env }) {
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(sources, 'sources-info.json'), 'utf8')); } catch (e) { return { ok: false, reason: `no pude leer sources-info.json en ${sources}: ${e.code || e.message}` }; }
  // con un solo repo (`single_repo` en la información de los bundles: el árbol publicado, con las skills adentro) hay un
  // solo bundle y un solo remoto, y la marca es opcional: sin ella el remoto no trae `friday`
  const single = info.single_repo === true;
  const remotes = {};
  for (const [key, name] of single ? [['harness', 'harness']] : [['harness', 'harness'], ['skills', 'agent-skills']]) {
    const bundle = path.join(sources, `${name}.bundle`);
    if (!fs.existsSync(bundle)) return { ok: false, reason: `no encuentro el bundle ${bundle}` };
    const dir = path.join(lab, 'remotes', `${name}.git`);
    if (fs.existsSync(dir)) return { ok: false, reason: `${dir} ya existe: el laboratorio es de una sola corrida` };
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = L.run('git', ['clone', '--quiet', '--bare', bundle, dir], { env, timeoutMs: 10 * 60 * 1000 });
    if (r.error || r.exit !== 0) return { ok: false, reason: `git clone --bare de ${name}.bundle salió ${r.error || r.exit}: ${L.firstLine(r.stderr)}` };
    // Un bundle no dice a qué rama apunta HEAD: al clonarlo git la adivina, y cuando `main` empata con `friday` o con
    // `base` puede elegir cualquiera de las dos (según cómo se llame la rama por defecto en la máquina). Los clones del
    // laboratorio siguen a `main`, que es la que se mueve del viernes a hoy: se fija acá, no se deja a la suerte.
    const headed = git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'], { env });
    if (headed.error || headed.exit !== 0) return { ok: false, reason: `no pude dejar main como la rama del remoto de ${name}: ${L.firstLine(headed.stderr) || headed.error || headed.exit}` };
    // una rama del remoto: su commit, `null` si no está (git sale 1), o tira si git no pudo contestar (no es «no está»)
    const at = (ref) => {
      const x = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { env });
      if (x.exit === 0) return L.firstLine(x.stdout);
      if (x.error || x.exit !== 1) throw new Error(`no pude leer ${ref} del bundle de ${name}: git rev-parse ${x.error || `salió ${x.exit}`}${L.firstLine(x.stderr) ? ` — ${L.firstLine(x.stderr)}` : ''}`);
      return null;
    };
    let friday; let target; let base;
    try { friday = at('refs/heads/friday'); target = at('refs/heads/main'); base = at('refs/heads/base'); } catch (e) { return { ok: false, reason: e.message }; }
    if (!target || (!friday && !single)) return { ok: false, reason: `el bundle de ${name} no trae las ramas main y friday` };
    // el bundle tiene que traer lo que su información declara: una marca pedida que no llegó no se pierde callada (el
    // ensayo diría «no medido»), y lo que se ensaya es el commit declarado (el que comprueba `--same-tree`), no otro
    const declared = info[key] || {};
    const off = [['main', declared.target, target], ['friday', declared.friday, friday], ['base', declared.base, base]]
      .filter(([, said, got]) => (said || null) !== (got || null))
      .map(([branch, said, got]) => `${branch} (declarado ${said ? String(said).slice(0, 10) : 'ninguno'}, en el bundle ${got ? got.slice(0, 10) : 'no está'})`);
    if (off.length) return { ok: false, reason: `el bundle de ${name} no trae lo que su información declara: ${off.join(' · ')}` };
    remotes[key] = { dir, friday, target, base };
  }
  const state = { schema: L.SCHEMA, made_by: 'scripts/tests/windows/team-lab.js', at: L.nowIso(), sources: info, remotes };
  if (single) state.single_repo = true;
  L.writeJsonAtomic(path.join(lab, STATE_FILE), state);
  return { ok: true, state };
}
function readState(lab) {
  try { return JSON.parse(fs.readFileSync(path.join(lab, STATE_FILE), 'utf8')); } catch (_) { return null; }
}
/** Apunta `main` de los dos remotos al commit del viernes (`friday`), al de hoy (`target`) o al «antes» (`base`). `null` si pudo, o el motivo. */
function pointRemotes(state, which, env) {
  for (const r of Object.values(state.remotes)) {
    if (!r[which]) return `el remoto ${r.dir} no trae el commit «${which}»`;
    const x = git(r.dir, ['update-ref', 'refs/heads/main', r[which]], { env });
    if (x.exit !== 0) return `no pude apuntar ${r.dir} a ${which}: ${L.firstLine(x.stderr) || x.error || x.exit}`;
  }
  return null;
}
/** Un archivo de un commit del remoto, sin clonar. `null` si no está. */
function showFile(remote, commit, rel, env) {
  const r = git(remote, ['show', `${commit}:${rel}`], { env, cap: 2 * 1024 * 1024 });
  return r.exit === 0 ? r.stdout : null;
}

// ── el texto del alta ────────────────────────────────────────────────────────────────────────────────────────────

/** Las líneas del paso `## PASO <n>` del texto (hasta el paso siguiente o el final del prompt). */
function docSection(text, n) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^## PASO ${n}\\b`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && (/^## PASO \d+\b/.test(l) || /═══ FIN DEL PROMPT ═══/.test(l)));
  if (end < 0) end = lines.length;
  return lines.slice(start, end);
}
/** Los bloques con valla ```<lang> de unas líneas, en orden y sin su sangría común. */
function fencedBlocks(lines, lang) {
  const out = [];
  let body = null;
  let indent = 0;
  for (const line of lines || []) {
    if (body === null) {
      const m = new RegExp(`^(\\s*)\`\`\`${lang}\\s*$`).exec(line);
      if (m) { body = []; indent = m[1].length; }
      continue;
    }
    if (/^\s*```\s*$/.test(line)) { out.push(body.join('\n')); body = null; continue; }
    body.push(line.slice(Math.min(indent, line.length - line.trimStart().length)));
  }
  return out;
}
const CLONE_URL = /git clone (https:\/\/[^\s"'`}]+)/;

/** Lo que le falta a un texto para ser de una forma: lo tira `need`, y `parseTeamDoc` lo junta. */
const need = (value, what) => { if (!value) throw new Error(what); return value; };

/** El texto del alta en su forma de DOS CLONES. Tira con la pieza que no encontró. */
function parseTwoClones(docText) {
  const s1 = fencedBlocks(need(docSection(docText, 1), 'el PASO 1'), 'powershell');
  need(s1.length >= 2, 'los dos bloques powershell del PASO 1 (clonar el arnés y agent-skills)');
  const links = need(fencedBlocks(docSection(docText, 2), 'powershell')[0], 'el bloque powershell del PASO 2 (los enlaces)');
  const importBlock = need(fencedBlocks(docSection(docText, 3), 'powershell')[0], 'el bloque powershell del PASO 3 (el import)');
  const s4 = need(docSection(docText, 4), 'el PASO 4');
  let startup = null;
  for (const block of fencedBlocks(s4, 'json')) {
    let parsed;
    try { parsed = JSON.parse(`{${block}}`); } catch (_) { continue; }
    const hook = parsed.SessionStart && parsed.SessionStart[0] && parsed.SessionStart[0].hooks && parsed.SessionStart[0].hooks[0];
    if (hook && /^\s*(pwsh|powershell)\b/.test(hook.command || '')) startup = { command: hook.command, async: hook.async === true };
  }
  need(startup, 'la línea de arranque de Windows del PASO 4 (el bloque json cuyo comando empieza con pwsh)');
  // el texto del alta nombraba el PowerShell como `<PS>` (el que hubiera); desde que PowerShell 7 es obligatorio dice
  // `pwsh`. Se leen las dos formas y se llevan a `<PS>`: cada máquina del ensayo corre el comando con SU PowerShell.
  const inline = s4.map((l) => /^\s*- Windows: `((?:<PS>|pwsh) [^`]+)`\s*$/.exec(l)).filter(Boolean).map((m) => m[1].replace(/^pwsh /, "<PS> "));
  const installer = need(inline.find((c) => /install-tycon-hooks\.ps1/.test(c)), 'el comando de Windows que corre el instalador a mano (PASO 4)');
  const jsonCheck = inline.find((c) => /ConvertFrom-Json/.test(c)) || null;
  const verifyAll = need(fencedBlocks(docSection(docText, 9), 'powershell')[0], 'el bloque powershell de la verificación final (PASO 9)');
  // la verificación, sin las líneas de lo que no se instaló (engram y BMAD)
  const verify = verifyAll.split('\n').filter((l) => !/engram|_bmad|bmad-/.test(l)).join('\n');
  const harnessUrl = need((CLONE_URL.exec(s1[0]) || [])[1], 'la dirección del repo del arnés después de «git clone» (PASO 1a)');
  const skillsUrl = need((CLONE_URL.exec(s1[1]) || [])[1], 'la dirección de agent-skills después de «git clone» (PASO 1b)');
  return {
    urls: { harness: harnessUrl, skills: skillsUrl },
    blocks: { clone_harness: s1[0], clone_skills: s1[1], links, import_line: importBlock, verify },
    startup, installer, json_check: jsonCheck,
  };
}

/**
 * El texto del alta en su forma de UN SOLO CLON: el PASO 1 clona un repo, el PASO 2 corre `harness.js install` (que
 * deja los enlaces, el import, la línea de arranque y los hooks), el PASO 3 mira los enlaces y el import, el PASO 4
 * trae el diagnóstico y la validación del JSON como comandos en línea, y el PASO 9 verifica. Tira con lo que no encontró.
 */
function parseOneClone(docText) {
  const s1 = fencedBlocks(need(docSection(docText, 1), 'el PASO 1'), 'powershell');
  need(s1.length === 1, 'un solo bloque powershell en el PASO 1 (clonar el repo del equipo)');
  // Desde la tanda B de la 8.16 el PASO 2 puede traer dos bloques: `install --dry-run` (el plan, para que el dev diga
  // que sí) y `install --yes` (la instalación). El ensayo no tiene a quién preguntarle: corre el que instala.
  const installBlocks = fencedBlocks(docSection(docText, 2), 'powershell').filter((b) => /harness\.js["']?\s+install\b/.test(b));
  const install = need(installBlocks.find((b) => /\binstall\b[^\n]*--yes\b/.test(b)) || installBlocks.find((b) => !/--dry-run\b/.test(b)) || installBlocks[0], 'el bloque powershell del PASO 2 que corre «harness.js install»');
  const checkLinks = need(fencedBlocks(docSection(docText, 3), 'powershell')[0], 'el bloque powershell del PASO 3 (verificar los enlaces y el import)');
  const s4 = need(docSection(docText, 4), 'el PASO 4');
  // los comandos en línea de la variante Windows; `pwsh` se lleva a `<PS>`, como en la otra forma
  const inline = s4.map((l) => /^\s*- Windows: `([^`]+)`\s*$/.exec(l)).filter(Boolean).map((m) => m[1].replace(/^pwsh /, '<PS> '));
  const doctor = need(inline.find((c) => /^node .*harness\.js["']?\s+doctor\s*$/.test(c)), 'el comando de Windows del diagnóstico («harness.js doctor», PASO 4)');
  const jsonCheck = inline.find((c) => /ConvertFrom-Json/.test(c)) || null;
  const verifyAll = need(fencedBlocks(docSection(docText, 9), 'powershell')[0], 'el bloque powershell de la verificación final (PASO 9)');
  // la misma regla que en la otra forma: la verificación, sin las líneas de lo que no se instaló (engram y BMAD)
  const verify = verifyAll.split('\n').filter((l) => !/engram|_bmad|bmad-/.test(l)).join('\n');
  const harnessUrl = need((CLONE_URL.exec(s1[0]) || [])[1], 'la dirección del repo después de «git clone» (PASO 1)');
  return {
    urls: { harness: harnessUrl, skills: null },
    blocks: { clone_harness: s1[0], install, check_links: checkLinks, verify },
    startup: null, installer: null, doctor, json_check: jsonCheck,
  };
}

/**
 * Lo que el ensayo necesita del texto del alta, en su rama de Windows, y qué forma tiene (`shape`: dos clones o un
 * solo clon). `{ problem }` si el texto no calza con ninguna de las dos, con lo que se buscó de cada una: un texto que
 * cambió de forma no se ensaya a medias.
 */
function parseTeamDoc(docText, stepZeroText) {
  if (!docText) return { problem: `no encuentro ${DOC} en el commit que se ensaya` };
  // la forma SIN CLON (story 8.23, tanda E): el PASO 1 ya no clona —la versión publicada la instaló el guion de la
  // portada con el permiso de lectura de la persona— y no trae ningún `git clone`. Ese alta se ensaya siguiendo la página
  // pública de instalación (`guided-install.js`), y sólo contra una copia publicada: en el árbol interno la página y el
  // guion de entrada son papeles con marcadores sin resolver, en otra ruta. Acá se dice NO MEDIDO con ese motivo, no
  // «no pude ensayar». Las dos formas con clon siguen leyéndose igual.
  const s1 = docSection(docText, 1) || [];
  if (s1.length && !s1.some((l) => CLONE_URL.test(l)) && s1.some((l) => /sin clonar|\.tycon[\\/]harness/.test(l))) {
    return { shape: SHAPE.none, not_measured: 'el alta sin clon se ensaya contra una copia publicada (la fuente github): el árbol interno no trae la página ni el guion de entrada en su lugar' };
  }
  const zero = /`(git clone [^`]+)`/.exec(String(stepZeroText || ''));
  const missing = [];
  for (const [shape, parse] of [[SHAPE.two, parseTwoClones], [SHAPE.one, parseOneClone]]) {
    try {
      const doc = parse(docText);
      return Object.assign({ shape, urls: doc.urls, step_zero: zero ? zero[1] : null }, doc);
    } catch (e) { missing.push(`la de ${SHAPE_TEXT[shape]}: no trae ${e.message}`); }
  }
  return { problem: `el texto del alta (${DOC}) no calza con ninguna de las dos formas — ${missing.join(' · ')}` };
}

/** ¿Ese commit del remoto trae ese archivo? `{ present }`, o `{ problem }` si git no lo pudo decir (no saber no es «no está»). */
function fileAt(remote, commit, rel, env) {
  const r = git(remote, ['ls-tree', '--name-only', commit, '--', rel], { env });
  if (r.error || r.exit !== 0) return { problem: `git ls-tree ${r.error || `salió ${r.exit}`}: ${L.firstLine(r.stderr) || 'sin mensaje'}` };
  return { present: r.stdout.split('\n').some((l) => l.trim() === rel) };
}
// lo que una versión publicada lleva en su raíz: con eso un árbol se declara «copia publicada»
const PUBLISHED_MARK = 'version.json';

/**
 * El texto del alta en un commit del remoto del arnés, ya leído: `{ doc }`, o por qué no se ensaya —`{ not_measured }`
 * (no es un error: no hay qué ensayar) o `{ problem }` (no se pudo ensayar)—.
 *   · Una copia publicada (trae `version.json` en su raíz) no lleva el texto del alta del equipo, que no se publica:
 *     ahí su falta es lo esperado → `not_measured`. En cualquier otro árbol, que falte sigue siendo un problema: un
 *     renombre o un árbol mal armado no pasan por «no hay qué ensayar».
 *   · Un texto de dos clones en un laboratorio de un solo repo no se puede ensayar: `problem`, con ese motivo.
 */
function readTeamDoc(state, commit, env) {
  const harness = state.remotes.harness;
  const has = fileAt(harness.dir, commit, DOC, env);
  if (has.problem) return { problem: `no pude leer ${DOC} del commit que se ensaya (${has.problem})` };
  if (!has.present) {
    const published = fileAt(harness.dir, commit, PUBLISHED_MARK, env);
    if (published.problem) return { problem: `no encuentro ${DOC} en el commit que se ensaya, y no pude saber si es una copia publicada (${published.problem})` };
    if (published.present) return { not_measured: `el árbol que se ensaya es una copia publicada (trae ${PUBLISHED_MARK}) y no lleva el texto del alta del equipo (${DOC} no se publica): acá no hay un alta del equipo que ensayar` };
    return { problem: `no encuentro ${DOC} en el commit que se ensaya` };
  }
  const text = showFile(harness.dir, commit, DOC, env);
  // el commit lo trae (lo dijo `fileAt`): si no se deja leer, es «no pude leer», no «no lo encuentro»
  if (text === null) return { problem: `no pude leer ${DOC} del commit que se ensaya (el commit lo trae y git show no lo devolvió)` };
  const doc = parseTeamDoc(text, showFile(harness.dir, commit, STEP_ZERO, env));
  if (doc.problem) return { problem: doc.problem };
  if (doc.not_measured) return { not_measured: doc.not_measured, shape: doc.shape };
  if (doc.shape === SHAPE.two && !state.remotes.skills) return { problem: 'el texto del alta es de dos clones y el laboratorio trae un solo repo: no hay un segundo repo que clonar' };
  return { doc };
}

/** Las líneas de arranque que una máquina vieja de Windows puede tener, de la lista de formas conocidas del árbol. */
function knownWindowsLines(fixtureText) {
  try {
    const forms = JSON.parse(fixtureText).forms || [];
    return forms.filter((f) => f && f.platform === 'windows' && f.expect === 'known' && typeof f.command === 'string').map((f) => ({ id: f.id, command: f.command, async: f.async !== false }));
  } catch (_) { return []; }
}

// ── el ambiente y PowerShell ─────────────────────────────────────────────────────────────────────────────────────

/**
 * El desvío de git de las direcciones del texto hacia los remotos del laboratorio (variables de ambiente): las dos, o
 * la única que nombra un texto de un solo clon (el remoto de agent-skills queda en el laboratorio y nadie lo clona).
 */
function redirectEnv(doc, state) {
  const first = L.gitRedirectEnv(doc.urls.harness, state.remotes.harness.dir, {});
  if (!doc.urls.skills) return first;
  return Object.assign({}, first, L.gitRedirectEnv(doc.urls.skills, state.remotes.skills.dir, first));
}

/** Tapa, en cualquier valor, las dos direcciones de los repos del equipo y las credenciales del ambiente. */
function redactor(doc, env = process.env) {
  const pairs = L.secretValues(env).map((s) => [s, L.REDACTED_SECRET]);
  for (const [url, mark] of [[doc && doc.urls && doc.urls.harness, '<team-harness-url>'], [doc && doc.urls && doc.urls.skills, '<team-skills-url>']]) if (url) pairs.push([url, mark]);
  pairs.sort((a, b) => b[0].length - a[0].length);
  const text = (s) => pairs.reduce((acc, [from, to]) => acc.split(from).join(to), s);
  const walk = (v) => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), walk(x)]));
    return v;
  };
  return walk;
}

/** Hace de cuenta que pasó el fin de semana: la última salida a la red del mecanismo queda tres días atrás (si no, una
 *  sesión que arranca a menos de diez minutos de otra no mira si hay versión nueva). `{ done, why }`. */
function simulateWeekend(home) {
  const file = path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json');
  try {
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!st || typeof st !== 'object' || !st.last_fetch) return { done: false, why: 'el estado no trae una última salida a la red' };
    st.last_fetch = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    L.writeJsonAtomic(file, st);
    return { done: true, why: null };
  } catch (e) { return { done: false, why: `sin estado del mecanismo (${e.code || e.message})` }; }
}

/** El mismo ambiente con `pwsh` fuera del PATH (queda el PowerShell 5.1 de Windows). `{ env, removed }` o `{ problem }`. */
function withoutPwsh(env, platform = process.platform) {
  const key = L.pathKey(env);
  const delimiter = L.isWin(platform) ? ';' : ':';
  const dirs = String(env[key] || '').split(delimiter).filter(Boolean);
  const has = (d) => ['pwsh', 'pwsh.exe'].some((n) => { try { return fs.statSync(path.join(d, n)).isFile(); } catch (_) { return false; } });
  const out = Object.assign({}, env, { [key]: dirs.filter((d) => !has(d)).join(delimiter) });
  const still = L.scanPath('pwsh', { env: out, platform });
  if (still.length) return { problem: `no pude quitar pwsh del PATH: sigue en ${still[0]}` };
  const lost = ['git', 'node'].filter((t) => !L.scanPath(t, { env: out, platform }).length);
  if (lost.length) return { problem: `quitar pwsh del PATH se lleva también a ${lost.join(' y ')} (viven en la misma carpeta): en esta máquina no se puede ensayar sin pwsh` };
  return { env: out, removed: dirs.filter(has) };
}

/** El ambiente de una carpeta de usuario del ensayo. */
function rehearsalEnv(home, { base = process.env, extra = {}, platform = process.platform } = {}) {
  return L.labEnv(home, { base, extra: Object.assign({}, REHEARSAL_ENV, extra), platform });
}

/**
 * Corre un texto de PowerShell tal cual, desde un archivo (no pasa por otra capa de comillas). Devuelve lo de `lab.run`.
 * Para el PowerShell 5.1 el archivo lleva la marca de orden de bytes: sin ella lee los acentos en otra codificación.
 */
function runPs({ ps, text, cwd, env, scratch, id, timeoutMs = BLOCK_TIMEOUT_MS }) {
  fs.mkdirSync(scratch, { recursive: true });
  const file = path.join(scratch, `${id}.ps1`);
  const old = /^powershell(\.exe)?$/i.test(path.basename(String(ps)));
  fs.writeFileSync(file, `${old ? '﻿' : ''}${text}\n`);
  return L.run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${L.PWSH_UTF8}. '${file.replace(/'/g, "''")}'; exit $LASTEXITCODE`], { cwd, env, timeoutMs });
}

// ── la instalación del equipo, paso por paso ─────────────────────────────────────────────────────────────────────

/** Suma la línea de arranque a `settings.json` como lo pide el PASO 4: copia antes, una sola, sin pisar lo demás. */
function mergeStartupLine(file, startup) {
  let settings = {};
  let existed = false;
  if (fs.existsSync(file)) {
    existed = true;
    settings = readJsonLoose(file).value;
    fs.copyFileSync(file, `${file}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`);
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks.SessionStart)) settings.hooks.SessionStart = [];
  const mine = { type: 'command', command: startup.command };
  if (startup.async) mine.async = true;
  let replaced = false;
  for (const group of settings.hooks.SessionStart) {
    for (const h of (group && group.hooks) || []) {
      if (!replaced && typeof h.command === 'string' && isHarnessStartup(h.command)) { Object.assign(h, mine); replaced = true; }
    }
  }
  if (!replaced) settings.hooks.SessionStart.push({ hooks: [mine] });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { existed, replaced };
}
const isNewStartup = (command) => String(command || '').includes(C.BOOTSTRAP_MARK);
const isOldStartup = (command) => !isNewStartup(command) && (/install-tycon-hooks/.test(String(command || '')) || (/git\b[^;|&]*\bpull\b/.test(String(command || '')) && /(tycon-claude-guides|agent-skills)/.test(String(command || ''))));
const isHarnessStartup = (command) => isNewStartup(command) || isOldStartup(command);

/** La carpeta donde quedó el clon del arnés: bajo `SourceCode`, la que trae el instalador de Windows. */
function findHarnessClone(home) {
  const root = path.join(home, 'SourceCode');
  try {
    for (const d of fs.readdirSync(root).sort()) if (fs.existsSync(path.join(root, d, 'scripts', 'install-tycon-hooks.ps1'))) return path.join(root, d);
  } catch (_) { /* sin carpeta */ }
  return null;
}

/** La línea de arranque del arnés que quedó registrada en `settings.json` (la primera): `{ command, async }` o `null`. */
function registeredStartup(file) {
  try {
    const h = C.registeredHooks(readJsonLoose(file).value).find((x) => isHarnessStartup(x.command));
    return h ? { command: h.command, async: h.is_async } : null;
  } catch (_) { return null; }
}

/**
 * Instala el arnés como lo hace un dev del equipo: los pasos de Windows del texto del alta, en orden, cada bloque tal
 * cual. `line` es la línea de arranque que el dev registra (la del texto, u otra forma vieja conocida); con un texto
 * de un solo clon no se usa: la línea la deja el instalador y acá sólo se anota cuál quedó.
 * Devuelve `{ steps, shape, clone, skills, settings, ps, problem }`: `problem` sólo si no se pudo ni empezar. `skills`
 * es la carpeta de las skills: su propio clon (`~/.claude/agent-skills`) o, con un solo clon, el clon del arnés.
 */
function teamInstall({ doc, home, scratch, env, ps, psName, line = null, id, say = () => {} }) {
  const out = { ps: psName, shape: doc.shape, steps: [], clone: null, skills: path.join(home, '.claude', 'agent-skills'), settings: path.join(home, '.claude', 'settings.json'), problem: null };
  if (!ps) { out.problem = `no hay ${psName} en el PATH con qué correr los bloques del alta`; return out; }
  const step = (name, what, fn) => {
    const t0 = Date.now();
    let s;
    try { s = Object.assign({ id: name, what }, fn()); } catch (e) { s = { id: name, what, threw: e.message }; }
    s.seconds = Math.round((Date.now() - t0) / 100) / 10;
    out.steps.push(s);
    say(`  ${id} · ${name}: ${s.threw ? `tiró — ${s.threw}` : (s.skipped ? `salteado — ${s.skipped}` : `salió ${s.error || s.exit}`)} (${s.seconds} s)`);
    return s;
  };
  const block = (name, what, text) => step(name, what, () => {
    const r = runPs({ ps, text, cwd: home, env, scratch, id: `${id}-${name}` });
    return { exit: r.exit, error: r.error, timed_out: r.timed_out, stdout: L.clip(r.stdout, 1500), stderr: L.clip(r.stderr, 1500) };
  });
  const forShell = (command) => command.replace(/<PS>/g, psName);

  if (doc.step_zero) block('step-0', 'el clon del arnés que pide el paso cero', doc.step_zero);
  if (doc.shape === SHAPE.one) {
    block('clone-harness', 'PASO 1: clonar el repo del equipo (uno solo)', doc.blocks.clone_harness);
    out.clone = findHarnessClone(home);
    if (!out.clone) { out.problem = 'después del PASO 1 no hay un clon del arnés bajo SourceCode (con scripts/install-tycon-hooks.ps1)'; return out; }
    // con un solo clon la carpeta de las skills ES el clon: trae `skills/` y `agents/` en su raíz
    out.skills = out.clone;
    block('install', 'PASO 2: el instalador (harness.js install): enlaces, import, línea de arranque y hooks', doc.blocks.install);
    // la línea de arranque no se escribe a mano: se anota la que dejó el instalador
    const left = registeredStartup(out.settings);
    out.startup_line = { command: left ? left.command : null, async: left ? left.async : null, from: 'el instalador (PASO 2)' };
    block('check-links', 'PASO 3: verificar los enlaces y el import', doc.blocks.check_links);
    block('doctor', 'PASO 4: el diagnóstico (harness.js doctor)', doc.doctor);
    if (doc.json_check) block('json-check', 'PASO 4: settings.json sigue siendo JSON', forShell(doc.json_check));
    block('verify', 'PASO 9: la verificación final (sin engram ni BMAD)', doc.blocks.verify);
    return out;
  }
  block('clone-harness', 'PASO 1a: clonar el arnés', doc.blocks.clone_harness);
  block('clone-skills', 'PASO 1b: clonar agent-skills', doc.blocks.clone_skills);
  out.clone = findHarnessClone(home);
  if (!out.clone) { out.problem = 'después del PASO 1 no hay un clon del arnés bajo SourceCode (con scripts/install-tycon-hooks.ps1)'; return out; }
  block('links', 'PASO 2: los enlaces de agents y skills', doc.blocks.links);
  block('import', 'PASO 3: el import en CLAUDE.md', doc.blocks.import_line);
  const startup = line || doc.startup;
  // quien sólo tiene el PowerShell 5.1 escribe la línea con `powershell` (lo dice el PASO 4)
  const command = psName === 'pwsh' ? startup.command : startup.command.replace(/^(\s*)pwsh\b/, `$1${psName}`);
  out.startup_line = { command, async: startup.async, from: line ? (line.id || 'forma vieja conocida') : 'el texto del alta' };
  step('startup-line', 'PASO 4: la línea de arranque en settings.json', () => Object.assign({ exit: 0 }, mergeStartupLine(out.settings, { command, async: startup.async })));
  block('installer', 'PASO 4: el instalador, una vez a mano', forShell(doc.installer));
  if (doc.json_check) block('json-check', 'PASO 4: settings.json sigue siendo JSON', forShell(doc.json_check));
  block('verify', 'PASO 9: la verificación final (sin engram ni BMAD)', doc.blocks.verify);
  return out;
}

// ── la foto ──────────────────────────────────────────────────────────────────────────────────────────────────────

const matcherKey = (m) => String(m || '').split('|').map((t) => t.trim()).filter(Boolean).sort().join('|');
const hookKey = (h) => `${h.event}:${h.name}${h.matcher ? `[${matcherKey(h.matcher)}]` : ''}`;

/** `settings.json`: cómo está escrito y qué registra. */
function settingsFacts(file, { platform = process.platform } = {}) {
  const out = { exists: fs.existsSync(file) };
  if (!out.exists) return out;
  let read;
  try { read = readJsonLoose(file); } catch (e) { out.problem = e.message; out.sha256 = sha(file); return out; }
  const raw = read.raw;
  const indented = /\n( +)"/.exec(raw);
  Object.assign(out, {
    sha256: sha(file), bytes: Buffer.byteLength(raw), bom: read.bom, crlf: raw.includes('\r\n'), ends_with_newline: /\n$/.test(raw),
    indent: indented ? indented[1].length : null, top_keys: Object.keys(read.value || {}),
  });
  const s = read.value && typeof read.value === 'object' ? read.value : {};
  out.env = s.env && typeof s.env === 'object' ? s.env : null;
  out.cleanup_period_days = s.cleanupPeriodDays === undefined ? null : s.cleanupPeriodDays;
  const all = C.registeredHooks(s);
  out.hooks = all.filter((h) => !isHarnessStartup(h.command)).map((h) => {
    const item = { event: h.event, matcher: h.matcher, name: h.file ? F.hookName(h.file, platform) : L.clip(h.command, 120), runner: h.runner, file: h.file, command: h.command, is_async: h.is_async };
    item.exists = h.file ? fs.existsSync(h.file) : null;
    if (h.file && /\.sh$/.test(h.file) && item.exists) { try { item.has_cr = fs.readFileSync(h.file).includes('\r\n'); } catch (_) { item.has_cr = null; } }
    return item;
  });
  out.startup_lines = all.filter((h) => isHarnessStartup(h.command)).map((h) => ({ event: h.event, command: h.command, is_async: h.is_async, form: isNewStartup(h.command) ? 'new' : 'old', shell: (/^\s*([A-Za-z0-9_.-]+)/.exec(h.command) || [])[1] || null }));
  const seen = {};
  for (const h of out.hooks) seen[hookKey(h)] = (seen[hookKey(h)] || 0) + 1;
  out.duplicated = Object.entries(seen).filter(([, n]) => n > 1).map(([key, times]) => ({ key, times }));
  out.dangling = out.hooks.filter((h) => h.exists === false).map((h) => ({ key: hookKey(h), file: h.file }));
  out.backups = (() => { try { return fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${path.basename(file)}.bak.`)).length; } catch (_) { return null; } })();
  return out;
}

/**
 * Los cuatro enlaces de `~/.claude` de una instalación del equipo, y a dónde tiene que llegar cada uno. Con dos clones,
 * `agent-skills` es su propio clon (`skills`); con uno solo, `agent-skills` llega al clon del arnés, y `skills` y
 * `agents` a sus carpetas dentro de él.
 */
function linkFacts(home, { clone, skills, shape = SHAPE.two, platform = process.platform }) {
  const root = shape === SHAPE.one ? clone : skills;
  const want = { [PLACE.PLACE_NAME]: clone, [PLACE.LEGACY_PLACE_NAME]: clone, 'agent-skills': root, agents: path.join(root, 'agents'), skills: path.join(root, 'skills') };
  const optional = placeNames(home);
  return LINK_NAMES.map((name) => {
    const p = path.join(home, '.claude', name);
    let st;
    try { st = fs.lstatSync(p); } catch (_) { return optional.has(name) ? null : { name, present: false, ok: false }; }
    const out = { name, present: true, kind: st.isSymbolicLink() ? 'link' : (st.isDirectory() ? 'folder' : 'file') };
    try { out.resolves_to = fs.realpathSync(p); } catch (e) { out.resolves_to = null; out.problem = e.code || e.message; }
    out.ok = Boolean(out.resolves_to) && Boolean(want[name]) && L.samePath(out.resolves_to, L.realOrSelf(want[name]), platform);
    return out;
  }).filter(Boolean);
}

function repoFacts(dir, env) {
  if (!dir || !fs.existsSync(dir)) return { exists: false };
  const one = (args) => { const r = git(dir, args, { env }); return r.exit === 0 ? L.firstLine(r.stdout) : null; };
  const status = git(dir, ['status', '--porcelain', '--untracked-files=no'], { env });
  const dirty = status.exit === 0 ? status.stdout.split('\n').filter(Boolean) : null;
  const gitDir = one(['rev-parse', '--absolute-git-dir']);
  return {
    exists: true, head: one(['rev-parse', 'HEAD']), branch: one(['symbolic-ref', '--short', '-q', 'HEAD']), origin_main: one(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']),
    dirty: dirty ? dirty.length : null, dirty_first: dirty ? dirty.slice(0, 6) : null,
    stashes: (() => { const r = git(dir, ['stash', 'list'], { env }); return r.exit === 0 ? r.stdout.split('\n').filter(Boolean).length : null; })(),
    in_progress: gitDir ? ['rebase-merge', 'rebase-apply', 'MERGE_HEAD'].filter((f) => fs.existsSync(path.join(gitDir, f))) : null,
    autocrlf: (() => { const r = git(dir, ['config', '--get', 'core.autocrlf'], { env }); return r.exit === 0 ? L.firstLine(r.stdout) : 'sin fijar'; })(),
  };
}

/** `harness.js doctor --json`: los `fail` y los `warn`, o por qué no se pudo leer. */
function doctorFacts(harness, env, cwd) {
  if (!fs.existsSync(harness)) return { readable: false, problem: `no existe ${harness}` };
  const r = L.run(process.execPath, [harness, 'doctor', '--json'], { env, cwd, timeoutMs: 120000, cap: 200000 });
  const out = { exit: r.exit, error: r.error };
  try {
    const d = JSON.parse(r.stdout);
    out.mode = d.mode || null;
    // el Node propio del arnés (story 8.39): con qué corre el arnés y cuántos hooks con él
    out.harness_node = d.harness_node || null;
    for (const level of ['fail', 'warn', 'ok']) out[level] = Array.isArray(d[level]) ? d[level].map((x) => L.clip(typeof x === 'string' ? x : JSON.stringify(x), 400)) : [];
    out.readable = Array.isArray(d.fail);
  } catch (e) {
    out.readable = false;
    out.problem = `no devolvió JSON: ${L.clip(r.stdout || r.stderr, 400)}`;
  }
  return out;
}

/** Los hooks registrados contra la lista que sale de leer el instalador del clon (la de Mac y Linux, que es la completa). */
function expectedFacts({ home, clone, settingsFile, env, platform = process.platform }) {
  try {
    const installer = fs.readFileSync(path.join(clone, 'scripts', 'install-tycon-hooks.sh'), 'utf8');
    const reader = path.join(clone, 'scripts', 'lib', 'tycon-config.js');
    let integrations = null;
    if (fs.existsSync(reader)) {
      const r = L.run(process.execPath, [reader, 'integrations', '--json'], { env, timeoutMs: 30000 });
      if (r.exit === 0) { try { integrations = JSON.parse(r.stdout); } catch (_) { integrations = null; } }
    }
    const exp = C.expectedHooks(installer, { integrations, env, home });
    if (exp.problems.length) return { problem: `la lista esperada no es de fiar: ${exp.problems.join(' · ')}` };
    const result = C.compare(exp.hooks, readJsonLoose(settingsFile).value, { superseded: exp.superseded, home, clone, platform });
    return {
      integrations, names: exp.hooks.map((h) => `${h.event}:${h.relpath}`), expected_total: result.expected_total, in_place: result.in_place,
      missing: result.missing.map((m) => m.hook), duplicated: result.duplicated.map((d) => d.hook), superseded: result.superseded.map((s) => s.hook),
      misplaced: result.misplaced.map((m) => m.hook), unexpected: result.unexpected.map((u) => u.hook), dangling: result.dangling.map((d) => d.hook),
    };
  } catch (e) { return { problem: e.message }; }
}

/** La foto de una carpeta de usuario con el arnés del equipo instalado, según la forma del alta (`shape`). Sólo lee. */
function photo({ home, clone, skills, shape = SHAPE.two, env, platform = process.platform }) {
  const dot = path.join(home, '.claude');
  const p = { at: L.nowIso() };
  p.settings = settingsFacts(path.join(dot, 'settings.json'), { platform });
  p.links = linkFacts(home, { clone, skills, shape, platform });
  const harness = path.join(clone, 'scripts', 'setup', 'harness.js');
  p.doctor = doctorFacts(harness, env, clone);
  const ver = fs.existsSync(harness) ? L.run(process.execPath, [harness, 'version'], { env, cwd: clone, timeoutMs: 60000, cap: 1200 }) : { exit: null, error: 'sin harness.js', stdout: '', stderr: '' };
  p.version = { exit: ver.exit, error: ver.error, text: L.clip(ver.stdout || ver.stderr, 600).trim() };
  try {
    const st = JSON.parse(fs.readFileSync(path.join(dot, '.tycon-pipeline', 'harness-state.json'), 'utf8'));
    p.state = { exists: true, mode: st.mode || null, channel: st.channel || null, version: st.version && st.version.number ? st.version.number : null, notice: st.notice || null, failed: st.failed || null, hold: st.hold || null, policy: st.policy || null, last_fetch: st.last_fetch || null, managed: Array.isArray(st.managed) ? st.managed.length : null, sources: Array.isArray(st.sources) ? st.sources.map((s) => ({ name: s.name, ref: s.ref, commit: s.commit })) : null };
  } catch (e) { p.state = { exists: fs.existsSync(path.join(dot, '.tycon-pipeline', 'harness-state.json')), problem: e.code || e.message }; }
  // con un solo clon no hay un segundo repo que fotografiar: las skills viven en el del arnés
  p.repos = shape === SHAPE.one ? { harness: repoFacts(clone, env) } : { harness: repoFacts(clone, env), skills: repoFacts(skills, env) };
  p.commands = (() => { try { return fs.readdirSync(path.join(dot, 'commands')).sort(); } catch (_) { return null; } })();
  try {
    const md = fs.readFileSync(path.join(dot, 'CLAUDE.md'), 'utf8');
    p.claude_md = { exists: true, imports: md.split(/\r?\n/).filter((l) => IMPORT_RX.test(l.replace(/^﻿/, ''))), blocks: (md.match(/TYCON_BLOCK:[^\s]+ START/g) || []).length, bom: md.charCodeAt(0) === 0xfeff, crlf: md.includes('\r\n') };
  } catch (_) { p.claude_md = { exists: false, imports: [] }; }
  const fixed = path.join(dot, '.tycon-pipeline', 'harness');
  p.fixed_copy = (() => {
    try {
      return fs.readdirSync(fixed).filter((f) => /^bootstrap/.test(f)).sort().map((f) => ({ file: f, has_cr: /\.sh$/.test(f) ? fs.readFileSync(path.join(fixed, f)).includes('\r\n') : null }));
    } catch (_) { return []; }
  })();
  p.startup_log_tail = (() => { try { return fs.readFileSync(path.join(fixed, 'startup.log'), 'utf8').split('\n').filter(Boolean).slice(-12).map((l) => L.clip(l, 400)); } catch (_) { return []; } })();
  p.expected = p.settings.exists && !p.settings.problem ? expectedFacts({ home, clone, settingsFile: path.join(dot, 'settings.json'), env, platform }) : { problem: 'sin settings.json legible' };
  return p;
}

// ── una sesión que arranca, y el humo de los hooks ───────────────────────────────────────────────────────────────

let shotCounter = 0;
function shoot(form, command, input, { cwd, env, timeoutMs, cap = 1500 }) {
  const [bin, args, opts] = form.launch(command, `r${++shotCounter}`);
  const r = L.run(bin, args, Object.assign({ cwd, env, input: JSON.stringify(input), timeoutMs, cap }, opts));
  return { form: form.id, exit: r.exit, error: r.error, timed_out: r.timed_out, blocked: r.exit === 2 || F.BLOCK_RX.test(r.stdout), ms: r.ms, out: r.stdout, err: r.stderr };
}

/** Las formas con que se lanza un comando en esta máquina, sin las de PowerShell (ver fire-registered.js). */
function launchForms({ env, platform = process.platform, scratch }) {
  const bashes = L.scanPath('bash', { env, platform });
  const gitBash = L.findGitBash({ platform, env, gitLocations: L.scanPath('git', { env, platform }), bashLocations: bashes }).path;
  const forms = F.shellForms({ platform, gitBash, firstBash: null, pwsh: null, scratch });
  return Object.fromEntries(forms.map((f) => [f.id, f]));
}

/**
 * Lo que corre solo al abrir una sesión: TODOS los hooks `SessionStart` de `settings.json`, en su orden, cada uno con
 * su `command` tal como quedó registrado. Devuelve `{ form, hooks: [...], log_lines, heads }` o `{ problem }`; `heads`
 * es el commit en que quedó cada clon (con un solo clon, sólo el del arnés).
 */
function fireSessionStart({ form, home, clone, skills, shape = SHAPE.two, env, label }) {
  const file = path.join(home, '.claude', 'settings.json');
  let settings;
  try { settings = readJsonLoose(file).value; } catch (e) { return { label, form: form.id, problem: `settings.json no se pudo leer: ${e.message}` }; }
  const logFile = path.join(home, '.claude', '.tycon-pipeline', 'harness', 'startup.log');
  const log = () => { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } };
  const before = log().length;
  const input = F.payload('SessionStart', { source: 'startup' }, { cwd: home, home });
  const rows = [];
  for (const h of C.registeredHooks(settings).filter((x) => x.event === 'SessionStart')) {
    const startup = isHarnessStartup(h.command);
    const row = shoot(form, h.command, input, { cwd: home, env, timeoutMs: startup ? STARTUP_TIMEOUT_MS : HOOK_TIMEOUT_MS });
    rows.push(Object.assign({ hook: startup ? 'startup-line' : (h.file ? F.hookName(h.file) : L.clip(h.command, 120)), startup: startup ? (isNewStartup(h.command) ? 'new' : 'old') : null }, row));
  }
  const heads = (dir) => { const r = git(dir, ['rev-parse', 'HEAD'], { env }); return r.exit === 0 ? L.firstLine(r.stdout) : null; };
  return { label, form: form.id, shell: form.shell, hooks: rows, log_lines: log().slice(before).map((l) => L.clip(l, 500)), heads: shape === SHAPE.one ? { harness: heads(clone) } : { harness: heads(clone), skills: heads(skills) }, settings_sha256: sha(file) };
}

/** Cada hook registrado (sin la línea de arranque), con una entrada legítima mínima, por cada forma. */
function smoke({ settingsFile, forms, home, scratch, env, platform = process.platform }) {
  let settings;
  try { settings = readJsonLoose(settingsFile).value; } catch (e) { return { problem: `settings.json no se pudo leer: ${e.message}`, rows: [] }; }
  const repo = path.join(scratch, 'smoke-repo');
  fs.mkdirSync(repo, { recursive: true });
  L.run('git', ['init', '-q', repo], { env, timeoutMs: 30000 });
  const hookEnv = Object.assign({}, env, { CLAUDE_PROJECT_DIR: repo });
  const rows = [];
  for (const h of C.registeredHooks(settings).filter((x) => !isHarnessStartup(x.command))) {
    const name = h.file ? F.hookName(h.file, platform) : L.clip(h.command, 120);
    const input = F.payload(h.event, F.genericInput(h.event, h.matcher, repo), { cwd: repo, home });
    for (const form of forms) {
      const r = shoot(form, h.command, input, { cwd: repo, env: hookEnv, timeoutMs: HOOK_TIMEOUT_MS, cap: 400 });
      rows.push({ key: hookKey({ event: h.event, name, matcher: h.matcher }), event: h.event, form: form.id, exit: r.exit, error: r.error, timed_out: r.timed_out, blocked: r.blocked, ms: r.ms, said: L.clip(tellingLine(r.err) || L.firstLine(r.out), 300) });
    }
  }
  return { rows };
}

// ── finales de línea ─────────────────────────────────────────────────────────────────────────────────────────────

/** Los `.sh` y `.ps1` de un clon que llegaron con `\r`, y si un `.sh` así todavía pasa por bash. */
function eolFacts(clone, { env, bash = null }) {
  // un nombre por línea y sin comillas: separados por ceros no sirve, `lab.run` borra los ceros de toda salida
  const r = L.run('git', ['-c', 'core.quotePath=false', '-C', clone, 'ls-files', '--', '*.sh', '*.ps1'], { env, cap: 4 * 1024 * 1024, timeoutMs: 60000 });
  if (r.error || r.exit !== 0) return { problem: `git ls-files ${r.error || `salió ${r.exit}`}: ${L.firstLine(r.stderr)}` };
  const out = { sh: { total: 0, with_cr: 0, first: [] }, ps1: { total: 0, with_cr: 0, first: [] } };
  for (const f of r.stdout.split('\n').filter(Boolean)) {
    const slot = /\.sh$/.test(f) ? out.sh : out.ps1;
    slot.total++;
    try { if (fs.readFileSync(path.join(clone, f)).includes('\r\n')) { slot.with_cr++; if (slot.first.length < 8) slot.first.push(f); } } catch (_) { /* un archivo que no se pudo leer no cuenta */ }
  }
  const cfg = git(clone, ['config', '--show-origin', '--get', 'core.autocrlf'], { env });
  out.autocrlf_in_clone = cfg.exit === 0 ? L.firstLine(cfg.stdout) : (cfg.exit === 1 ? 'sin fijar' : `no pude leerlo (${cfg.error || cfg.exit})`);
  out.gitattributes = fs.existsSync(path.join(clone, '.gitattributes'));
  // la prueba de que rompe: bash lee el primero que llegó con `\r` (sólo lo lee: -n)
  if (bash && out.sh.first.length) {
    const b = L.run(bash, ['-n', path.join(clone, out.sh.first[0])], { env, timeoutMs: 30000, cap: 600 });
    out.bash_reads_first = { file: out.sh.first[0], exit: b.exit, error: b.error, said: L.firstLine(b.stderr) };
  }
  return out;
}

/** ¿Cada PowerShell de la máquina puede LEER (sin correr) los `.ps1` que el arnés le pide correr? */
function psParseFacts(files, shells, env) {
  const out = [];
  for (const [name, ps] of Object.entries(shells)) {
    if (!ps) { out.push({ shell: name, not_measured: `no hay ${name} en el PATH` }); continue; }
    const ver = L.run(ps, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { env, timeoutMs: 60000, cap: 300 });
    for (const file of files.filter((f) => fs.existsSync(f))) {
      const script = `${L.PWSH_UTF8}$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$t, [ref]$e); "$($e.Count)|$(if ($e.Count) { $e[0].Message } else { '' })"`;
      const r = L.run(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env, timeoutMs: 60000, cap: 800 });
      const [n, first] = L.firstLine(r.stdout).split('|');
      out.push({ shell: name, version: L.firstLine(ver.stdout) || null, file: path.basename(file), exit: r.exit, error: r.error, parse_errors: /^\d+$/.test(n || '') ? Number(n) : null, first: first || L.firstLine(r.stderr) || null });
    }
  }
  return out;
}

// ── juzgar una foto, y comparar dos ──────────────────────────────────────────────────────────────────────────────

const finding = (id, severity, kind, detail) => ({ id, severity, kind, detail });
const gates = new Set(['PreToolUse', 'UserPromptSubmit', 'Stop']);
/** Un mensaje de `doctor` sin lo que cambia de una corrida a otra (commits, fechas, rutas, números). */
const normal = (s) => String(s).replace(/[0-9a-f]{7,40}/g, '#').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '@').replace(/[A-Za-z]:[\\/][^\s:·)]+|\/[^\s:·)]+/g, '~').replace(/\d+/g, 'N');

/** Lo que una foto dice por sí sola (sirve para el alta, donde no hay un «antes»). */
function judgePhoto(p, { expectUpdated = null } = {}) {
  const out = [];
  if (!p.settings.exists) out.push(finding('settings:missing', SEVERITY.breaks, 'settings', 'no quedó settings.json en la carpeta de usuario: no hay ningún hook registrado'));
  else if (p.settings.problem) out.push(finding('settings:unreadable', SEVERITY.breaks, 'settings', `settings.json no es JSON: ${p.settings.problem}`));
  else {
    if (p.settings.bom) out.push(finding('settings:bom', SEVERITY.loses, 'settings', 'settings.json quedó con la marca de orden de bytes al principio: Node no lo lee como JSON, y el mecanismo de instalación lo da por ilegible'));
    for (const d of p.settings.dangling) out.push(finding(`hooks:dangling:${d.key}`, SEVERITY.loses, 'hook', `${d.key} quedó registrado y su archivo no existe: ${d.file}`));
    for (const d of p.settings.duplicated) out.push(finding(`hooks:duplicated:${d.key}`, SEVERITY.noise, 'hook', `${d.key} quedó registrado ${d.times} veces: corre ${d.times} veces por evento`));
    for (const h of p.settings.hooks.filter((x) => x.has_cr)) out.push(finding(`hooks:sh-with-cr:${hookKey(h)}`, SEVERITY.loses, 'line-endings', `${hookKey(h)} es un .sh que llegó con \\r: bash no lo corre`));
    const lines = p.settings.startup_lines;
    if (lines.length === 0) out.push(finding('startup:not-registered', SEVERITY.loses, 'startup-line', 'settings.json no trae la línea de arranque del arnés: la máquina no se actualiza sola'));
    if (lines.length > 1) out.push(finding('startup:registered-more-than-once', SEVERITY.noise, 'startup-line', `la línea de arranque quedó ${lines.length} veces (${lines.map((l) => l.form).join(', ')})`));
  }
  for (const l of p.links) {
    if (!l.present) out.push(finding(`links:missing:${l.name}`, SEVERITY.breaks, 'link', `no existe ~/.claude/${l.name}: ${l.name === 'skills' ? 'el asistente no ve ninguna skill' : (l.name === 'agents' ? 'el asistente no ve ningún revisor' : 'el arnés no se encuentra a sí mismo')}`));
    else if (!l.ok) out.push(finding(`links:wrong:${l.name}`, SEVERITY.breaks, 'link', `~/.claude/${l.name} (${l.kind}) no llega a donde tiene que llegar: ${l.resolves_to || l.problem}`));
  }
  if (!p.doctor.readable) out.push(finding('doctor:unreadable', SEVERITY.loses, 'doctor', `harness.js doctor --json (salió ${p.doctor.exit === undefined ? '—' : p.doctor.exit}) no se pudo leer: ${p.doctor.problem || ''}`));
  else {
    if (p.doctor.mode === 'no instalado') out.push(finding('doctor:not-installed', SEVERITY.loses, 'doctor', 'harness.js doctor dice «no instalado»: el mecanismo de instalación no tiene estado en esta máquina (ni versión, ni vuelta atrás, ni actualización por el mecanismo)'));
    for (const f of p.doctor.fail) out.push(finding(`doctor:fail:${normal(f).slice(0, 80)}`, SEVERITY.loses, 'doctor', `doctor en rojo: ${f}`));
  }
  if (p.version.exit !== 0) out.push(finding('version:failed', SEVERITY.noise, 'version', `harness.js version salió ${p.version.error || p.version.exit}: ${p.version.text}`));
  if (!p.claude_md.exists || !p.claude_md.imports.length) out.push(finding('import:missing', SEVERITY.loses, 'import', 'CLAUDE.md no trae el import de las guías del equipo: las reglas del arnés no se cargan en la sesión'));
  else if (p.claude_md.bom) out.push(finding('import:bom', SEVERITY.loses, 'import', 'CLAUDE.md empieza con la marca de orden de bytes: el primer import puede no leerse'));
  if (p.expected.problem) out.push(finding('hooks:expected-unknown', SEVERITY.noise, 'hook', `no pude comparar contra la lista del instalador: ${p.expected.problem}`));
  else for (const m of p.expected.missing) out.push(finding(`hooks:missing:${m}`, SEVERITY.loses, 'hook', `el hook ${m} está en la lista del instalador de Mac y Linux y no quedó registrado`));
  for (const [name, r] of Object.entries(p.repos)) {
    if (!r.exists) { out.push(finding(`repo:missing:${name}`, SEVERITY.breaks, 'repo', `no está el clon de ${name}`)); continue; }
    if (r.in_progress && r.in_progress.length) out.push(finding(`repo:in-progress:${name}`, SEVERITY.breaks, 'repo', `el clon de ${name} quedó a mitad de una operación de git (${r.in_progress.join(', ')})`));
    if (r.branch !== 'main') out.push(finding(`repo:off-main:${name}`, SEVERITY.loses, 'repo', `el clon de ${name} quedó en ${r.branch || 'un commit suelto'} y no en main: no se actualiza`));
    if (r.dirty) out.push(finding(`repo:dirty:${name}`, SEVERITY.noise, 'repo', `el clon de ${name} quedó con ${r.dirty} archivo(s) versionado(s) modificado(s): ${(r.dirty_first || []).join(' · ')}`));
    if (expectUpdated && expectUpdated[name] && r.head !== expectUpdated[name]) out.push(finding(`update:not-applied:${name}`, SEVERITY.loses, 'update', `el clon de ${name} sigue en ${String(r.head).slice(0, 10)} y no en el commit de hoy (${expectUpdated[name].slice(0, 10)}): lo que entró esta semana no llegó`));
  }
  if (p.state && p.state.failed) out.push(finding('state:failed', SEVERITY.loses, 'state', `el mecanismo anotó una actualización fallida: ${L.clip(JSON.stringify(p.state.failed), 300)}`));
  if (p.state && p.state.notice) out.push(finding('state:notice', SEVERITY.noise, 'state', `aviso pendiente para el dev: ${L.clip(p.state.notice, 400)}`));
  return out;
}

/**
 * Las diferencias entre la foto del viernes y la de hoy, cada una con su gravedad. Función pura.
 * `sessions` son las sesiones que arrancaron en el medio; `smokeBefore`/`smokeAfter`, el humo de los hooks.
 */
function comparePhotos(before, after, { sessions = [], smokeBefore = null, smokeAfter = null, target = null } = {}) {
  const out = [];
  const add = (...a) => { const f = finding(...a); if (!out.some((x) => x.id === f.id)) out.push(f); };
  const wasFine = (id) => !judgePhoto(before).some((f) => f.id === id);
  // 1 · lo que la foto de hoy dice por sí sola y la del viernes no decía
  for (const f of judgePhoto(after, { expectUpdated: target })) {
    // faltar contra la lista de Mac y Linux es lo de siempre en Windows (lo midió `measure`): acá sólo cuentan los
    // hooks que el viernes ESTABAN y hoy no, que salen más abajo como `hooks:lost`
    if (/^hooks:missing:/.test(f.id)) continue;
    if (f.id === 'state:notice' && before.state && before.state.notice === after.state.notice) continue;
    if (wasFine(f.id) || /^update:not-applied/.test(f.id)) add(f.id, f.severity, f.kind, f.detail);
  }
  // 2 · los hooks que estaban el viernes y hoy no
  const keys = (p) => new Set(((p.settings && p.settings.hooks) || []).map(hookKey));
  const had = keys(before); const has = keys(after);
  const expectedToday = new Set((after.expected && after.expected.names) || []);
  for (const k of had) {
    if (has.has(k)) continue;
    const plain = k.replace(/\[.*\]$/, '');
    const retired = after.expected && !after.expected.problem && !expectedToday.has(plain);
    add(`hooks:lost:${k}`, retired ? SEVERITY.noise : SEVERITY.loses, 'hook', retired ? `${k} estaba el viernes y hoy no; la lista del instalador de hoy ya no lo trae (retirado a propósito)` : `${k} estaba registrado el viernes y hoy no está: se perdió en la actualización`);
  }
  const gained = [...has].filter((k) => !had.has(k));
  // 3 · la línea de arranque
  const lineOf = (p) => ((p.settings && p.settings.startup_lines) || []).map((l) => `${l.form}:${l.shell}`).join(',');
  if (lineOf(before) !== lineOf(after)) add('startup:line-changed', SEVERITY.noise, 'startup-line', `la línea de arranque pasó de «${lineOf(before) || 'ninguna'}» a «${lineOf(after) || 'ninguna'}»`);
  // 4 · doctor
  if (before.doctor.readable && after.doctor.readable) {
    const old = new Set(before.doctor.warn.map(normal));
    for (const w of after.doctor.warn) if (!old.has(normal(w))) add(`doctor:new-warn:${normal(w).slice(0, 80)}`, SEVERITY.noise, 'doctor', `doctor suma un aviso que el viernes no daba: ${w}`);
    if (after.doctor.fail.length < before.doctor.fail.length) add('doctor:better', SEVERITY.noise, 'doctor', `doctor mejoró: ${before.doctor.fail.length} rojo(s) el viernes, ${after.doctor.fail.length} hoy`);
  }
  // 5 · cómo quedó escrito settings.json, y lo que el arnés le sumó
  const sb = before.settings || {}; const sa = after.settings || {};
  if (sa.exists && !sa.problem && sb.exists && !sb.problem) {
    const shape = (s) => `sangría ${s.indent}, ${s.crlf ? 'CRLF' : 'LF'}${s.bom ? ', con marca de orden de bytes' : ''}${s.ends_with_newline ? '' : ', sin salto final'}`;
    if (shape(sb) !== shape(sa)) add('settings:rewritten', SEVERITY.noise, 'settings', `settings.json cambió de forma: ${shape(sb)} → ${shape(sa)}`);
    const keysOf = (s) => [...(s.top_keys || []).filter((k) => k !== 'hooks'), ...Object.keys(s.env || {}).map((k) => `env.${k}`)].sort();
    const plus = keysOf(sa).filter((k) => !keysOf(sb).includes(k)); const minus = keysOf(sb).filter((k) => !keysOf(sa).includes(k));
    if (minus.length) add('settings:keys-lost', SEVERITY.loses, 'settings', `settings.json perdió claves que el viernes tenía: ${minus.join(', ')}`);
    if (plus.length) add('settings:keys-added', SEVERITY.noise, 'settings', `settings.json suma claves: ${plus.join(', ')}`);
    const common = (s, other) => (s.top_keys || []).filter((k) => (other.top_keys || []).includes(k)).join(',');
    if (common(sb, sa) !== common(sa, sb)) add('settings:keys-reordered', SEVERITY.noise, 'settings', `settings.json cambió el orden de sus claves: ${common(sb, sa)} → ${common(sa, sb)}`);
    if ((sa.backups || 0) > (sb.backups || 0)) add('settings:more-backups', SEVERITY.noise, 'settings', `quedaron ${(sa.backups || 0) - (sb.backups || 0)} copia(s) .bak más de settings.json`);
    if (gained.length) add('hooks:gained', SEVERITY.noise, 'hook', `hooks nuevos registrados (${gained.length}): ${gained.join(', ')}`);
  }
  // 6 · ~/.claude/commands
  const cb = before.commands || []; const ca = after.commands || [];
  const gone = cb.filter((c) => !ca.includes(c));
  if (gone.length) add('commands:lost', SEVERITY.loses, 'commands', `~/.claude/commands perdió: ${gone.join(', ')}`);
  const fresh = ca.filter((c) => !cb.includes(c));
  if (fresh.length) add('commands:added', SEVERITY.noise, 'commands', `~/.claude/commands suma: ${fresh.join(', ')}`);
  // 7 · la versión
  if (before.version.text !== after.version.text) add('version:changed', SEVERITY.noise, 'version', `versión: «${before.version.text || '—'}» → «${after.version.text || '—'}»`);
  // 8 · el arranque: qué dijo cada sesión
  for (const s of sessions) {
    if (s.problem) { add(`session:${s.form}:unreadable-settings`, SEVERITY.breaks, 'session', `sesión ${s.label} (${s.form}): ${s.problem}`); continue; }
    for (const h of s.hooks) {
      const said = L.clip(tellingLine(h.err) || L.firstLine(h.out), 300);
      if (h.startup && (h.error || h.exit !== 0)) add(`session:${s.form}:startup-line-failed`, SEVERITY.loses, 'session', `la línea de arranque (${h.startup === 'new' ? 'nueva' : 'vieja'}), lanzada por ${s.form}, ${h.error ? `no arrancó (${h.error})` : `salió ${h.exit}`}${said ? ` — ${said}` : ''}`);
      else if (h.startup && L.firstLine(h.err)) add(`session:${s.form}:startup-line-stderr`, SEVERITY.noise, 'session', `la línea de arranque, lanzada por ${s.form}, salió 0 y escribió en el canal de errores: ${L.firstLine(h.err)}`);
      else if (!h.startup && (h.error || h.exit !== 0)) add(`session:${s.form}:hook-failed:${h.hook}`, SEVERITY.noise, 'session', `${h.hook} (SessionStart), lanzado por ${s.form}, ${h.error ? `no arrancó (${h.error})` : `salió ${h.exit}`}${said ? ` — ${said}` : ''}`);
    }
  }
  // dos sesiones seguidas lanzadas igual que dejan settings.json distinto: cada arranque lo reescribe
  // la sesión que corre después de avanzar los clones a mano («hoy-a-mano», update-probe.js) estrena código nuevo: que
  // escriba settings.json una vez es lo esperado, no «cada arranque»; se comparan las de antes de ese avance
  const fine = sessions.filter((x) => !x.problem && x.settings_sha256 && x.label !== 'hoy-a-mano');
  const [prev, last] = fine.slice(-2);
  if (prev && last && prev.form === last.form && prev.settings_sha256 !== last.settings_sha256) add('settings:rewritten-every-session', SEVERITY.noise, 'settings', `dos sesiones seguidas (${prev.label} y ${last.label}, las dos por ${last.form}) dejaron settings.json distinto: cada arranque lo vuelve a escribir`);
  // 9 · el humo: un hook que el viernes pasaba una entrada legítima y hoy no
  if (smokeAfter && smokeAfter.rows) {
    const prev = new Map(((smokeBefore && smokeBefore.rows) || []).map((r) => [`${r.key}|${r.form}`, r]));
    for (const r of smokeAfter.rows) {
      // frenar una entrada legítima cuenta aunque salga 0: un hook frena también imprimiendo el bloqueo en JSON
      const failed = (x) => Boolean(x.error || x.exit !== 0 || x.blocked);
      if (!failed(r)) continue;
      const old = prev.get(`${r.key}|${r.form}`);
      // «ya fallaba igual»: la misma salida, el mismo error y el mismo freno; un cambio de falla se reporta
      if (old && failed(old) && old.exit === r.exit && (old.error || null) === (r.error || null) && Boolean(old.blocked) === Boolean(r.blocked)) continue;
      const blocks = r.blocked && gates.has(r.event);
      const was = !old ? ' (hook nuevo)' : !failed(old) ? ' (el viernes salía 0)' : ` (el viernes ${old.error ? `no arrancaba: ${old.error}` : `salía ${old.exit}${old.blocked ? ' y frenaba' : ''}`})`;
      add(`smoke:${r.form}:${r.key}`, blocks ? SEVERITY.breaks : SEVERITY.loses, 'smoke', `${r.key}, lanzado por ${r.form} con una entrada legítima, ${r.error ? `no arrancó (${r.error})` : `salió ${r.exit}${r.blocked ? ' y frenó' : ''}`}${blocks ? ' y FRENA: bloquea cada uso de esa herramienta' : ''}${was}${r.said ? ` — ${r.said}` : ''}`);
    }
  }
  return out.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

/** Las respuestas cortas de una variante: ¿quedó sana?, ¿se actualizó?, ¿qué le dice al dev? */
function answers(before, after, differences, { sessions = [], target = null } = {}) {
  const count = (sev) => differences.filter((d) => d.severity === sev).length;
  const updated = target ? Object.entries(target).every(([name, commit]) => after.repos[name] && after.repos[name].head === commit) : null;
  const texts = [after.state && after.state.notice, ...sessions.flatMap((s) => (s.hooks || []).flatMap((h) => [h.out, h.err])), ...sessions.flatMap((s) => s.log_lines || [])].filter(Boolean).join('\n');
  const mentions = texts.split('\n').map((l) => l.trim()).filter((l) => /pwsh|PowerShell 7|falta .* en el PATH|instal[áa]/i.test(l)).slice(0, 6).map((l) => L.clip(l, 300));
  const kept = before && before.settings && before.settings.hooks ? before.settings.hooks.filter((h) => ((after.settings && after.settings.hooks) || []).some((x) => hookKey(x) === hookKey(h))).length : null;
  return {
    healthy: count(SEVERITY.breaks) === 0 && count(SEVERITY.loses) === 0,
    updated,
    by_severity: { breaks: count(SEVERITY.breaks), 'loses-control': count(SEVERITY.loses), noise: count(SEVERITY.noise) },
    doctor: { before: before && before.doctor.readable ? before.doctor.fail.length : null, after: after.doctor.readable ? after.doctor.fail.length : null, same_or_better: Boolean(before && before.doctor.readable && after.doctor.readable && after.doctor.fail.length <= before.doctor.fail.length) },
    hooks: { before: before && before.settings.hooks ? before.settings.hooks.length : null, after: after.settings.hooks ? after.settings.hooks.length : null, kept },
    sessions_started: sessions.map((s) => ({ label: s.label, form: s.form, startup_exit: ((s.hooks || []).find((h) => h.startup) || {}).exit, startup_error: ((s.hooks || []).find((h) => h.startup) || {}).error || null })),
    what_the_dev_is_told: mentions,
  };
}

/**
 * La capa del equipo de la A2, de juguete (story 8.25, tanda A2b · T28): la declaración, el perfil y la llave de la A1 más un
 * paquete con un revisor `base` y uno `condicional`, sus dos agentes, una skill de una carpeta y una anidada a tres (con una
 * referencia). Nombres inventados. `second: false` es el commit siguiente: sin el revisor condicional (ni en el paquete) y sin
 * la skill de una carpeta. Escribe en `dir` (lo que había de la capa lo reemplaza) y devuelve las rutas, ordenadas.
 */
const LAYER_A2 = Object.freeze({ pack: 'equipo-lab-a2', base: 'rev-lab-base', cond: 'rev-lab-cond', single: 'sola-lab', nested: 'projects/cliente-lab/arq-lab' });
function writeTeamLayerA2(dir, { second = true } = {}) {
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); return rel; };
  for (const sub of ['agents', 'packs', 'skills']) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
  const agent = (n) => `---\nname: ${n}\ndescription: revisor del equipo de juguete (ensayo de Windows)\nmodel: sonnet\ntools: Read, Grep, Glob\n---\n\nRevisa cosas del equipo de juguete.\n`;
  const skill = (n) => `---\nname: ${n}\ndescription: skill del equipo de juguete (ensayo de Windows)\n---\nUsala para probar.\n`;
  const reviewer = (a, group) => ({ agent: a, group, when: { detection: 'codeModified' }, surface: { paths: ['**/*.ts'] }, depth: 'standard', prefixes: ['LAB'] });
  const reviewers = [reviewer(LAYER_A2.base, 'base'), ...(second ? [reviewer(LAYER_A2.cond, 'condicional')] : [])];
  const out = [
    put('team-layer.json', '{ "schema": 1, "name": "equipo-lab", "requires": { "harness": ">= 2026.10.01.1" } }\n'),
    put('perfil-equipo.json', `${JSON.stringify({ ado: { org: 'https://dev.azure.com/acme' }, integrations: { engram: true, nightly: true }, update: { channel: 'latest', apply: 'auto' }, packs: { default: 'all' }, install: { profile: 'full' } }, null, 2)}\n`),
    put('scripts/metrics/corridas-buzon.json', '{ "_que_es": "la llave de JUGUETE del buzón (ensayo): no abre nada", "cuenta": "labcorridas", "contenedor": "corridas", "sas": "sv=lab", "vence": "2099-01-01" }\n'),
    put(`packs/${LAYER_A2.pack}/pack.json`, `${JSON.stringify({ name: LAYER_A2.pack, description: 'paquete del equipo de juguete (ensayo de Windows)', reviewers }, null, 2)}\n`),
    put(`agents/${LAYER_A2.base}.md`, agent(LAYER_A2.base)),
    put(`skills/${LAYER_A2.nested}/SKILL.md`, skill(path.posix.basename(LAYER_A2.nested))),
    put(`skills/${LAYER_A2.nested}/references/a.md`, '# referencia de juguete\n'),
  ];
  if (second) out.push(put(`agents/${LAYER_A2.cond}.md`, agent(LAYER_A2.cond)), put(`skills/${LAYER_A2.single}/SKILL.md`, skill(LAYER_A2.single)));
  return out.sort();
}

/**
 * La capa de juguete de la A2c (story 8.25 · T37): la skill de la lista FIJA de la versión (`skills/bizuit-sdd`, el nombre de la
 * lista; TODO su contenido inventado) con sus dos archivos de datos, más el perfil, la llave y la declaración. Devuelve las rutas.
 */
const LAYER_A2C = Object.freeze({ skill: 'skills/bizuit-sdd', version: '2.0.0-ensayo', legacy: '.bizuit-config.yaml', home: '.bizuit-sdd', file: 'config.yaml' });
function writeTeamLayerA2c(dir) {
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); return rel; };
  for (const sub of ['agents', 'packs', 'skills']) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
  const S = LAYER_A2C.skill;
  return [
    put('team-layer.json', '{ "schema": 1, "name": "equipo-lab", "requires": { "harness": ">= 2026.10.01.1" } }\n'),
    put('perfil-equipo.json', `${JSON.stringify({ ado: { org: 'https://dev.azure.com/acme' }, integrations: { engram: true, nightly: true }, update: { channel: 'latest', apply: 'auto' }, packs: { default: 'all' }, install: { profile: 'full' } }, null, 2)}\n`),
    put('scripts/metrics/corridas-buzon.json', '{ "_que_es": "la llave de JUGUETE del buzón (ensayo): no abre nada", "cuenta": "labcorridas", "contenedor": "corridas", "sas": "sv=lab", "vence": "2099-01-01" }\n'),
    put(`${S}/SKILL.md`, '---\nname: bizuit-sdd\ndescription: skill de juguete con datos (ensayo de Windows)\n---\nUsala para probar.\n'),
    put(`${S}/docs/guia.md`, '# guía de juguete\n'),
    put(`${S}/VERSION`, `${LAYER_A2C.version}\n`),
    put(`${S}/templates/shared-styles.css`, 'body { color: black; }\n'),
  ].sort();
}

module.exports = {
  LAYER_A2, writeTeamLayerA2, LAYER_A2C, writeTeamLayerA2c,
  STATE_FILE, DOC, STEP_ZERO, KNOWN_LINES, SEVERITY, SEVERITY_TEXT, SEVERITY_ORDER, NOT_REHEARSED, REHEARSAL_ENV,
  SHAPE, SHAPE_TEXT, notRehearsed,
  readJsonLoose, makeRemotes, readState, pointRemotes, showFile, fileAt,
  docSection, fencedBlocks, parseTeamDoc, readTeamDoc, knownWindowsLines,
  redirectEnv, redactor, simulateWeekend, withoutPwsh, rehearsalEnv, runPs,
  mergeStartupLine, isNewStartup, isOldStartup, isHarnessStartup, findHarnessClone, registeredStartup, teamInstall,
  hookKey, settingsFacts, linkFacts, repoFacts, doctorFacts, expectedFacts, photo,
  launchForms, fireSessionStart, smoke, eolFacts, psParseFacts,
  judgePhoto, comparePhotos, answers, lastLines, tellingLine,
};
