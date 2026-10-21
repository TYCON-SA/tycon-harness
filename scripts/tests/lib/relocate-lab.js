'use strict';
/**
 * relocate-lab.js — la máquina de juguete: una HOME de laboratorio ya instalada que registró
 * cosas por el nombre viejo del lugar del arnés. La usan harness-reroot.test.js y harness-relocate.test.js (Node, para
 * que corran iguales en el agente Windows).
 *
 * 🔴 Nunca la HOME real: `createLab` fija HOME y USERPROFILE a su carpeta y se niega a seguir (exit 3) si os.homedir()
 * devuelve otra. Enlaces y carpetas de verdad (en Windows, junctions).
 *
 * Las plantillas viven en scripts/tests/fixtures/relocate-machine/. Marcas: {{LEGACY}} (la ruta absoluta del nombre viejo,
 * como la escribe el sistema), {{LEGACY_SLASH}} (con `/`), {{LEGACY_TOML}} (escapada para TOML), {{LEGACY_NAME}} (el
 * nombre viejo suelto, leído de place.js: no se escribe en las plantillas), {{REAL}} (la ruta real del clon) y {{FOREIGN}}
 * (una carpeta ajena). En los .json el valor va escapado como cadena JSON.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'relocate-machine');
const IS_WIN = process.platform === 'win32';
const LINK_TYPE = IS_WIN ? 'junction' : 'dir';
const PLACE = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'place.js'));

/** La carpeta del laboratorio, con HOME y USERPROFILE apuntando a ella. Sale 3 si os.homedir() da otra. */
function createLab(prefix) {
  const lab = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  process.env.HOME = lab;
  process.env.USERPROFILE = lab;
  if (path.resolve(os.homedir()) !== path.resolve(lab)) {
    process.stderr.write(`${prefix}: me niego a correr — os.homedir() es ${os.homedir()}, no la carpeta del laboratorio ${lab}\n`);
    try { fs.rmdirSync(lab); } catch (_) { /* nada */ }
    process.exit(3);
  }
  return lab;
}

function makeLab(lab) {
  let seq = 0;
  const dir = (...p) => { const d = path.join(lab, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  /** Un clon de juguete: el instalador (criterio de «clon válido»), hooks y un comando que trae el árbol. */
  function clone(name, { full = false } = {}) {
    const d = dir('clones', `${name}-${++seq}`);
    fs.mkdirSync(path.join(d, 'scripts', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(d, 'scripts', 'install-tycon-hooks.sh'), '#!/usr/bin/env bash\nexit 0\n');
    for (const h of ['lab-guard.js', 'lab-twin.js', 'lab-real.js']) fs.writeFileSync(path.join(d, 'scripts', 'hooks', h), '// hook de juguete\n');
    fs.writeFileSync(path.join(d, 'scripts', 'hooks', 'lab-start.sh'), '#!/usr/bin/env bash\n');
    fs.mkdirSync(path.join(d, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(d, 'commands', 'lab-cmd.md'), 'el comando de juguete del arnés\n');
    fs.writeFileSync(path.join(d, 'README.md'), '# arnés de juguete\n');
    fs.writeFileSync(path.join(d, 'testigo.txt'), 'el clon de la persona\n');
    if (full) {
      // el código que corre, copiado (uno enlazado no sirve: canonical-path.js resuelve la ruta real)
      fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(d, 'scripts', 'lib'), { recursive: true });
      fs.cpSync(path.join(ROOT, 'scripts', 'setup'), path.join(d, 'scripts', 'setup'), { recursive: true });
    }
    return fs.realpathSync(d);
  }
  function home(name) { const h = dir('homes', `${name}-${++seq}`); fs.mkdirSync(path.join(h, '.claude'), { recursive: true }); return h; }
  return { dir, clone, home };
}

const placeOf = (h) => PLACE.placePath(h);
const legacyOf = (h) => PLACE.legacyPlacePath(h);
const link = (target, at) => fs.symlinkSync(target, at, LINK_TYPE);

/** Las variables de la máquina de juguete (sin ellas, las piezas irían a la HOME por defecto del laboratorio). */
function machineEnv(h, extra = {}) {
  return Object.assign({}, process.env, {
    HOME: h, USERPROFILE: h,
    CODEX_HOME: path.join(h, '.codex'),
    TYCON_GIT_HOOKS_DIR: path.join(h, '.git-hooks'),
    TYCON_LAUNCHAGENTS_DIR: path.join(h, 'Library', 'LaunchAgents'),
    TYCON_SETTINGS_PATH: path.join(h, '.claude', 'settings.json'),
    CLAUDE_MD_PATH: path.join(h, '.claude', 'CLAUDE.md'),
    TYCON_PROFILE: '0', TYCON_NO_NIGHTLY_EXAM: '1', TYCON_NO_GUI_ENV: '1',
    TYCON_LEGACY_NAMES_MAP: '',
  }, extra);
}

/** Reemplaza las marcas de una plantilla. `json`: los valores escapados como cadena JSON. */
function fill(text, vals, { json = false } = {}) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
    if (!(k in vals)) throw new Error(`plantilla con una marca desconocida: ${m}`);
    return json ? JSON.stringify(String(vals[k])).slice(1, -1) : String(vals[k]);
  });
}

/**
 * Arma la máquina en `h`: el lugar → el clon, el viejo → el lugar, y los archivos de las
 * plantillas. Devuelve las rutas. `plists: false` en Windows (no hay LaunchAgents).
 */
function machine(lab, h, clone, { plists = !IS_WIN, foreign } = {}) {
  link(clone, placeOf(h));
  link(placeOf(h), legacyOf(h));
  const legacy = legacyOf(h);
  const vals = {
    LEGACY: legacy, LEGACY_SLASH: legacy.split(path.sep).join('/'), LEGACY_TOML: legacy.replace(/\\/g, '\\\\'),
    LEGACY_NAME: PLACE.LEGACY_PLACE_NAME, REAL: clone, FOREIGN: foreign || path.join(lab, 'ajeno'),
  };
  const tpl = (n) => fs.readFileSync(path.join(FIXTURE, n), 'utf8');
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const files = {
    settings: put(path.join(h, '.claude', 'settings.json'), fill(tpl('settings.json'), vals, { json: true })),
    codexHooks: put(path.join(h, '.codex', 'hooks.json'), fill(tpl('codex-hooks.json'), vals, { json: true })),
    codexToml: put(path.join(h, '.codex', 'config.toml'), fill(tpl('config.toml'), vals)),
    gitLocal: put(path.join(h, '.git-hooks', 'pre-commit.local'), fill(tpl('pre-commit.local'), vals)),
    command: put(path.join(h, '.claude', 'commands', 'lab-cmd.md'), fill(tpl('lab-cmd.md'), vals)),
    ownCommand: put(path.join(h, '.claude', 'commands', 'mine.md'), fill(tpl('lab-cmd.md'), vals)),
    claudeMd: put(path.join(h, '.claude', 'CLAUDE.md'), fill(tpl('claude-md.txt'), vals)),
    // las COPIAS que el arnés gestiona (iguales a su fuente en el árbol): nombran la ruta vieja y no son registros
    gitPreCommit: put(path.join(h, '.git-hooks', 'pre-commit'), fill(tpl('git-pre-commit-global.sh'), vals)),
  };
  put(path.join(clone, 'scripts', 'hooks', 'git-pre-commit-global.sh'), fill(tpl('git-pre-commit-global.sh'), vals));
  put(path.join(clone, 'commands', 'lab-cmd.md'), fill(tpl('lab-cmd.md'), vals));
  if (plists) {
    const agents = path.join(h, 'Library', 'LaunchAgents');
    files.plistLoaded = put(path.join(agents, 'lab-loaded.plist'), fill(tpl('lab-loaded.plist'), vals));
    files.plistIdle = put(path.join(agents, 'lab-idle.plist'), fill(tpl('lab-idle.plist'), vals));
    // un plist binario: la cabecera de verdad y la ruta adentro (latin1), como lo deja launchctl a veces
    files.plistBinary = put(path.join(agents, 'lab-binary.plist'), '');
    fs.writeFileSync(files.plistBinary, Buffer.concat([Buffer.from('bplist00', 'latin1'), Buffer.from([0, 1, 2]), Buffer.from(`${vals.LEGACY_SLASH}/scripts/lab/bin.sh`, 'latin1'), Buffer.from([0])]));
  }
  return { legacy, place: placeOf(h), vals, files };
}

/** Un guion de mentira (sh) con el cuerpo dado; null en Windows (los casos que lo usan no aplican ahí). */
function fakeBin(lab, name, body) {
  if (IS_WIN) return null;
  const f = path.join(lab, 'bin', name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(f, 0o755);
  return f;
}

/** Un `plutil` de mentira que deja el binario como XML con la ruta del viejo adentro. */
function fakePlutil(lab, legacySlash) {
  return fakeBin(lab, 'plutil', `[ "$1" = "-convert" ] && [ "$2" = "xml1" ] || exit 64
cat > "$3" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>lab.binary</string><key>ProgramArguments</key><array><string>${legacySlash}/scripts/lab/bin.sh</string></array></dict></plist>
XML`);
}
/** Un `launchctl` de mentira: anota cada llamada; sólo `lab.loaded` está cargado. */
function fakeLaunchctl(lab, logFile) {
  return fakeBin(lab, 'launchctl', `echo "$*" >> '${logFile}'
case "$1" in
  print) case "$2" in */lab.loaded) exit 0 ;; *) exit 1 ;; esac ;;
esac
exit 0`);
}

/** El hash de lo que hay bajo `h` (nombres, tipos, destinos de enlaces, contenidos). */
function homeHash(h, { skip = [] } = {}) {
  const hash = crypto.createHash('sha256');
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (skip.some((s) => p === s || p.startsWith(s + path.sep))) continue;
      const s = fs.lstatSync(p);
      if (s.isSymbolicLink()) hash.update(`L ${p} ${fs.readlinkSync(p)}\n`);
      else if (s.isDirectory()) { hash.update(`D ${p}\n`); walk(p); } else hash.update(`F ${p} ${fs.readFileSync(p).toString('base64')}\n`);
    }
  };
  walk(h);
  return hash.digest('hex');
}

/** Los `command` de los hooks de un settings, por evento. */
function hookCommands(data) {
  const out = [];
  for (const [ev, groups] of Object.entries((data && data.hooks) || {})) {
    for (const g of groups || []) for (const x of (g && g.hooks) || []) if (x && typeof x.command === 'string') out.push(`${ev} ${x.command}`);
  }
  return out;
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
/** ¿Cuántas veces aparece el nombre viejo del lugar como ruta del lugar (`.claude/<viejo>` seguido de fin o separador)? */
function legacyMentions(text) {
  const re = new RegExp(`\\.claude[/\\\\]+${PLACE.LEGACY_PLACE_NAME}(?![\\w.@+~-])`, 'g');
  return (String(text).match(re) || []).length;
}

module.exports = {
  ROOT, FIXTURE, IS_WIN, LINK_TYPE, PLACE, createLab, makeLab, placeOf, legacyOf, link, machineEnv, fill, machine, fakeBin,
  fakePlutil, fakeLaunchctl, homeHash, hookCommands, readJson, legacyMentions,
};
