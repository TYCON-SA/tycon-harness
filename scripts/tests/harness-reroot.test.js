'use strict';
/**
 * harness-reroot.test.js — `legacy-names.js --migrate-machine --reroot <de> <a>`: cambiar la raíz de lo que la máquina
 * tiene escrito. En Node a propósito: corre igual en el agente Windows.
 *
 * El lugar del arnés se llama como el repo público (place.js) y el nombre viejo sigue resolviendo. Lo que una
 * máquina registró por el nombre viejo (hooks, permisos, los .local de git, Codex, LaunchAgents, comandos) sigue
 * andando, pero el día que el viejo se retire se rompe. `--reroot` lo pasa al lugar, con cuatro reglas que no se negocian:
 * no resuelve enlaces (si lo hiciera, reescribiría también lo registrado por la ruta real del clon), compara la ruta
 * completa (`…/<viejo>-viejo/…` no se toca), a un permiso le AGREGA la forma nueva al lado (un permiso es un patrón contra
 * lo que otro escribe: sacar la vieja vuelve a preguntar), y un hook que ya estaba por la ruta real pierde su gemelo por
 * el viejo. Anda sin el mapa de renombres, que no viaja a la copia pública.
 *
 * Qué fija:
 *   T19 cada forma escrita de `placeForms` en darwin y en win32, reescrita en su misma forma; el `<de>` pelado; el
 *       parecido y la ruta real intactos; ningún `$` nuevo; y el contador de `doctor` da el mismo número;
 *   T20 la máquina de juguete entera: hooks por el lugar, permiso con dos formas, gemelo fuera y dicho, repetido una vez,
 *       el plist cargado se recarga y el otro no, el binario se convierte, el comando del arnés cambia y el propio no;
 *       una segunda corrida no cambia nada;
 *   T21 sin renames.json da lo mismo; `--only-existing` no toca una ruta que no existe bajo `<a>`;
 *   T22 los errores, de a uno: `<a>` que no existe (1, sin escribir), un archivo que no parsea, un plist binario sin
 *       plutil, un archivo que no se puede respaldar (nombrados, los demás siguen), `--check` (cuenta y no escribe) y
 *       `--reroot` con una sola ruta (2, con el uso).
 */
const LABLIB = require('./lib/relocate-lab.js');

const LAB = LABLIB.createLab('harness-reroot');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const { ROOT, IS_WIN, PLACE, placeOf, legacyOf, machineEnv, machine, fakePlutil, fakeLaunchctl, homeHash, hookCommands, readJson, legacyMentions } = LABLIB;
const LN_FILE = path.join(ROOT, 'scripts', 'lib', 'legacy-names.js');
const LN = require(LN_FILE);
const { clone, home } = LABLIB.makeLab(LAB);
test.after(() => { try { fs.rmSync(LAB, { recursive: true, force: true }); } catch (_) { /* nada */ } });

function reroot(h, args, env = {}) {
  const r = spawnSync(process.execPath, [LN_FILE, '--migrate-machine', ...args, '--home', h], { encoding: 'utf8', env: machineEnv(h, env) });
  const lines = String(r.stdout || '').split('\n');
  const m = /^REROOTED:(\d+)$/.exec(lines[0] || '');
  let json = null;
  const brace = String(r.stdout || '').indexOf('\n{');
  if (brace >= 0) { try { json = JSON.parse(String(r.stdout).slice(brace + 1)); } catch (_) { json = null; } }
  return { rc: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), n: m ? Number(m[1]) : null, json };
}
const dollars = (s) => (String(s).match(/\$/g) || []).length;
const dd0 = () => `/Users/Lab/.claude/${PLACE.LEGACY_PLACE_NAME}`;

// ── T19 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T19 Reroot_AllWrittenForms_NoRealpath_EndOfPathBorder_SameExpressionAsDoctor', () => {
  assert.strictEqual(typeof LN.placeForms, 'function', 'legacy-names.js no exporta placeForms');
  assert.strictEqual(typeof LN.rerootText, 'function', 'legacy-names.js no exporta rerootText');
  const L = PLACE.LEGACY_PLACE_NAME; const N = PLACE.PLACE_NAME;
  // darwin: absoluta, ~/, $HOME/, ${HOME}/ — y NO la ruta real (un enlace no se sigue)
  const h = home('formas'); const C = clone('C');
  fs.symlinkSync(C, legacyOf(h), LABLIB.LINK_TYPE);
  const forms = LN.placeForms(legacyOf(h), h, 'darwin');
  for (const f of [legacyOf(h), `~/.claude/${L}`, `$HOME/.claude/${L}`, `\${HOME}/.claude/${L}`]) assert.ok(forms.includes(f), `falta la forma ${f}: ${forms.join(' | ')}`);
  assert.ok(!forms.some((f) => f.includes(C)), `placeForms siguió el enlace hasta ${C}`);
  // win32: con \ y con /, la unidad en mayúscula y minúscula, Git Bash, %USERPROFILE%, $env:USERPROFILE y \\ escapadas
  const wh = 'C:\\Users\\Lab'; const wd = `${wh}\\.claude\\${L}`;
  const wf = LN.placeForms(wd, wh, 'win32');
  const want = [wd, `C:/Users/Lab/.claude/${L}`, `c:\\Users\\Lab\\.claude\\${L}`, `c:/Users/Lab/.claude/${L}`, `/c/Users/Lab/.claude/${L}`,
    `%USERPROFILE%\\.claude\\${L}`, `$env:USERPROFILE\\.claude\\${L}`, `~/.claude/${L}`, `$HOME/.claude/${L}`, `\${HOME}/.claude/${L}`,
    `C:\\\\Users\\\\Lab\\\\.claude\\\\${L}`];
  for (const f of want) assert.ok(wf.includes(f), `win32: falta la forma ${f}: ${wf.join(' | ')}`);
  // cada forma, reescrita en la suya; el pelado también; el parecido y la ruta real intactos; ningún $ nuevo
  const to = `${wh}\\.claude\\${N}`;
  for (const f of wf) {
    const src = `run "${f}\\scripts\\x.js" ; also "${f}/scripts/y.js" ; bare=${f}`;
    const r = LN.rerootText(src, { from: wd, to, home: wh, platform: 'win32' });
    assert.strictEqual(r.n, 3, `la forma ${f}: ${r.n} reemplazos en «${src}» → «${r.text}»`);
    assert.ok(!r.text.includes(`.claude\\${L}`) && !r.text.includes(`.claude/${L}`) && !r.text.includes(`.claude\\\\${L}`), `quedó el viejo: ${r.text}`);
    assert.strictEqual(dollars(r.text), dollars(src), `agregó un $: ${r.text}`);
  }
  // Windows no distingue mayúsculas: otra caja, Git Bash con la unidad en mayúscula, %USERPROFILE%/ y ~\ también
  for (const v of [`C:/users/lab/.claude/${L}/x.js`, `/C/Users/Lab/.claude/${L}/x.js`, `%USERPROFILE%/.claude/${L}/x.js`, `~\\.claude\\${L}\\x.js`, `c:\\USERS\\LAB\\.CLAUDE\\${L.toUpperCase()}\\x.js`]) {
    const r = LN.rerootText(`run "${v}"`, { from: wd, to, home: wh, platform: 'win32' });
    assert.strictEqual(r.n, 1, `win32, otra forma o caja: «${v}» → «${r.text}»`);
    assert.ok(!r.text.includes('undefined') && r.text.includes(N), `win32: el reemplazo de «${v}» quedó «${r.text}»`);
  }
  assert.strictEqual(LN.rerootText(`run "C:/users/lab/.claude/${L}/x.js"`, { from: dd0(), to: `/Users/Lab/.claude/${N}`, home: '/Users/Lab', platform: 'darwin' }).n, 0, 'fuera de Windows la caja sí cuenta');
  const lookalike = `node "${wh}\\.claude\\${L}-viejo\\x.js" "C:/real/clone/scripts/x.js"`;
  assert.strictEqual(LN.rerootText(lookalike, { from: wd, to, home: wh, platform: 'win32' }).n, 0, 'tocó el parecido o la ruta real');
  const dh = '/Users/Lab'; const dd = `${dh}/.claude/${L}`;
  const dsrc = `"${dd}/scripts/a.js" "~/.claude/${L}" "$HOME/.claude/${L}/b" "\${HOME}/.claude/${L}/c" "${dd}-viejo/x" "/Users/Lab/SourceCode/arnes/x"`;
  // `${VAR:-$HOME/…}` (como lo escribe un guion de git): el `-` delante de `$` no es parte de un nombre
  const dv = LN.rerootText(`x="\${TYCON_GUIDES_DIR:-$HOME/.claude/${L}}" y="\${A:-~/.claude/${L}/b}"`, { from: dd0(), to: `/Users/Lab/.claude/${N}`, home: '/Users/Lab', platform: 'darwin' });
  assert.strictEqual(dv.n, 2, `«:-$HOME/…» y «:-~/…»: ${dv.text}`);
  const dr = LN.rerootText(dsrc, { from: dd, to: `${dh}/.claude/${N}`, home: dh, platform: 'darwin' });
  assert.strictEqual(dr.n, 4, `darwin: ${dr.text}`);
  assert.ok(dr.text.includes(`${dd}-viejo/x`) && dr.text.includes('/Users/Lab/SourceCode/arnes/x'), `darwin: tocó el parecido o la ruta real: ${dr.text}`);
  assert.strictEqual(dollars(dr.text), dollars(dsrc));
  // el contador de doctor, con la misma expresión, sobre la misma máquina: el mismo número que --reroot --check
  const mh = home('contador'); const MC = clone('MC'); machine(LAB, mh, MC);
  const counted = LN.countRegistered({ from: legacyOf(mh), home: mh, env: machineEnv(mh), tree: MC });
  const r = reroot(mh, ['--reroot', legacyOf(mh), placeOf(mh), '--check']);
  assert.strictEqual(r.rc, 0, r.err);
  assert.ok(counted.total > 0, 'el contador no vio nada');
  assert.strictEqual(counted.total, r.n, `doctor cuenta ${counted.total}, --reroot --check ${r.n}`);
  assert.ok(!counted.files.some((f) => /^(commands\/lab-cmd\.md|git-hooks\/pre-commit)$/.test(f.file)), `el contador contó una copia gestionada: ${JSON.stringify(counted.files)}`);
  // una máquina que nunca tuvo el nombre viejo, con las copias del arnés instaladas: 0
  const nh = home('nunca-viejo'); const NC = clone('NC'); const nm = machine(LAB, nh, NC, { plists: false });
  for (const f of ['settings', 'codexHooks', 'codexToml', 'gitLocal', 'ownCommand']) fs.unlinkSync(nm.files[f]);
  fs.unlinkSync(legacyOf(nh));
  assert.strictEqual(LN.countRegistered({ from: legacyOf(nh), home: nh, env: machineEnv(nh), tree: NC }).total, 0, 'una máquina sin nada registrado por el viejo no da 0');
  // el gemelo con matcher «*» por el viejo y sin matcher por la ruta real, con y sin comillas: el del viejo se va
  const th = home('gemelo-matcher'); const TC = clone('TC'); const tm = machine(LAB, th, TC, { plists: false });
  fs.writeFileSync(tm.files.settings, JSON.stringify({ hooks: { PreToolUse: [
    { hooks: [{ type: 'command', command: `node "${TC}/scripts/hooks/lab-twin.js"` }] },
    { matcher: '*', hooks: [{ type: 'command', command: `node ~/.claude/${L}/scripts/hooks/lab-twin.js` }] },
  ] } }, null, 2));
  const tr = reroot(th, ['--reroot', legacyOf(th), placeOf(th), '--json']);
  assert.deepStrictEqual(hookCommands(readJson(tm.files.settings)), [`PreToolUse node "${TC}/scripts/hooks/lab-twin.js"`], `el gemelo con otro matcher o sin comillas quedó: ${tr.out}`);
});

// ── T20 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T20 Reroot_HooksRewritten_PermissionsAdded_RealPathTwinDropped_Dedupe_LaunchctlPlutil_Commands', () => {
  const h = home('maquina'); const C = clone('arbol');
  const m = machine(LAB, h, C);
  const log = path.join(LAB, `launchctl-${path.basename(h)}.log`);
  const env = IS_WIN ? {} : { LAUNCHCTL_BIN: fakeLaunchctl(LAB, log), PLUTIL_BIN: fakePlutil(LAB, m.vals.LEGACY_SLASH) };
  const before = readJson(m.files.settings);
  const r = reroot(h, ['--reroot', m.legacy, m.place, '--json'], env);
  assert.strictEqual(r.rc, 0, `${r.out}${r.err}`);
  assert.ok(r.n > 0 && r.json, `sin REROOTED ni detalle: ${r.out}`);
  const s = readJson(m.files.settings);
  const cmds = hookCommands(s);
  // hooks: por el lugar, en su forma; ninguno por el viejo
  const P = PLACE.PLACE_NAME; const L = PLACE.LEGACY_PLACE_NAME;
  assert.ok(cmds.some((c) => c.includes('lab-guard.js') && c.includes(m.place)), `el hook absoluto no quedó por el lugar: ${cmds.join('\n')}`);
  assert.ok(cmds.includes(`SessionStart bash "\${HOME}/.claude/${P}/scripts/hooks/lab-start.sh"`), `la forma \${HOME} no quedó en su forma: ${cmds.join('\n')}`);
  assert.strictEqual(cmds.filter((c) => /lab-start\.sh/.test(c)).length, 1, `el repetido no quedó una vez: ${cmds.join('\n')}`);
  assert.strictEqual(cmds.filter((c) => new RegExp(`\\.claude[/\\\\]+${L}(?![\\w.-])`).test(c)).length, 0, `quedó un hook por el viejo: ${cmds.join('\n')}`);
  // el gemelo por la ruta real: queda el de la ruta real, se va el del viejo, y se dice
  const twins = cmds.filter((c) => c.includes('lab-twin.js'));
  assert.strictEqual(twins.length, 1, `gemelos: ${twins.join('\n')}`);
  assert.ok(twins[0].includes(C), `quedó el del viejo y no el de la ruta real: ${twins[0]}`);
  const dropped = [].concat(...r.json.files.map((f) => f.dropped || []));
  assert.ok(dropped.some((d) => /lab-twin/.test(d.command) && d.why === 'twin'), `el gemelo no se dijo: ${JSON.stringify(dropped)}`);
  assert.ok(dropped.some((d) => /lab-start/.test(d.command) && d.why === 'repeated'), `el repetido no se dijo: ${JSON.stringify(dropped)}`);
  assert.strictEqual(hookCommands(before).length - cmds.length, dropped.length, 'la cuenta de hooks no bajó exactamente en los dichos');
  // el parecido, el ajeno y la ruta real: intactos
  assert.ok(cmds.some((c) => c.includes(`${L}-viejo`)), 'tocó el parecido');
  assert.ok(cmds.some((c) => c.includes('ajeno')), 'tocó el ajeno');
  assert.ok(cmds.some((c) => c.includes('lab-real.js') && c.includes(C)), 'tocó el de la ruta real');
  // el permiso: la forma vieja sigue y tiene al lado la nueva
  const allow = s.permissions.allow;
  const iOld = allow.findIndex((p) => p.includes(`/.claude/${L}/`));
  assert.ok(iOld >= 0, `el permiso viejo se fue: ${allow.join(' | ')}`);
  assert.ok(allow[iOld + 1] && allow[iOld + 1].includes(`/.claude/${P}/`), `la forma nueva no quedó al lado: ${allow.join(' | ')}`);
  assert.ok(allow.includes('Bash(git status)'), 'tocó un permiso ajeno');
  // la statusLine
  assert.ok(s.statusLine.command.includes(`$HOME/.claude/${P}/`), `statusLine: ${s.statusLine.command}`);
  // Codex, git, el comando del arnés (y no el propio)
  assert.strictEqual(legacyMentions(fs.readFileSync(m.files.codexHooks, 'utf8')), 0, 'Codex hooks.json');
  assert.strictEqual(legacyMentions(fs.readFileSync(m.files.codexToml, 'utf8')), 0, 'Codex config.toml');
  assert.strictEqual(legacyMentions(fs.readFileSync(m.files.gitLocal, 'utf8')), 0, 'pre-commit.local');
  // las copias que gestiona el arnés (el comando que trae el árbol, el pre-commit global) no son registros: no se tocan
  // (las pone al día el instalador desde su fuente); un comando propio de la persona sí es un registro
  assert.strictEqual(legacyMentions(fs.readFileSync(m.files.command, 'utf8')), 1, 'tocó la copia del comando que trae el árbol');
  assert.strictEqual(legacyMentions(fs.readFileSync(m.files.gitPreCommit, 'utf8')), 1, 'tocó la copia del pre-commit global');
  assert.ok(!r.json.files.some((f) => /^(commands\/lab-cmd\.md|git-hooks\/pre-commit)$/.test(f.label)), 'contó una copia gestionada');
  assert.strictEqual(legacyMentions(fs.readFileSync(m.files.ownCommand, 'utf8')), 0, 'no mudó el comando propio de la persona');
  assert.strictEqual(legacyMentions(fs.readFileSync(m.files.claudeMd, 'utf8')), 1, '--reroot no toca CLAUDE.md (es de relocate)');
  // respaldo al lado de cada archivo cambiado
  const changed = r.json.files.filter((f) => f.rerooted > 0);
  const plistBak = path.join(h, '.claude', '.tycon-pipeline', 'reroot-bak');
  for (const f of changed) {
    // un plist no se respalda al lado: launchd podría cargar el respaldo como un segundo trabajo con la ruta vieja
    const dir = f.label.startsWith('LaunchAgents/') ? plistBak : path.dirname(f.path);
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith(`${path.basename(f.path)}.bak-reroot-`)), `sin respaldo de ${f.path} en ${dir}`);
  }
  if (!IS_WIN) assert.ok(!fs.readdirSync(path.join(h, 'Library', 'LaunchAgents')).some((n) => n.includes('.bak-reroot-')), 'un respaldo quedó en LaunchAgents');
  if (!IS_WIN) {
    // los plist: el cargado se recarga, el otro no; el binario se convirtió y quedó por el lugar
    assert.strictEqual(legacyMentions(fs.readFileSync(m.files.plistLoaded, 'utf8')), 0);
    assert.strictEqual(legacyMentions(fs.readFileSync(m.files.plistIdle, 'utf8')), 0);
    const bin = fs.readFileSync(m.files.plistBinary, 'utf8');
    assert.ok(bin.startsWith('<?xml') && legacyMentions(bin) === 0 && bin.includes(`/.claude/${P}/`), `el binario: ${bin}`);
    const calls = fs.readFileSync(log, 'utf8');
    assert.match(calls, /bootout gui\/\d+\/lab\.loaded/, `no recargó el cargado: ${calls}`);
    assert.match(calls, /bootstrap gui\/\d+ .*lab-loaded\.plist/, `no volvió a cargar el cargado: ${calls}`);
    assert.doesNotMatch(calls, /bootout gui\/\d+\/lab\.idle/, `recargó uno que no estaba cargado: ${calls}`);
  } else process.stdout.write('# ⏭ T20: los LaunchAgents no aplican en Windows\n');
  // ningún $ nuevo en todo settings.json
  assert.strictEqual(dollars(JSON.stringify(s.hooks)), dollars(JSON.stringify(before.hooks)) - dollars(dropped.map((d) => d.command).join('')), 'apareció un $ nuevo en los hooks');
  // una segunda corrida no cambia nada
  const hash = homeHash(h);
  const again = reroot(h, ['--reroot', m.legacy, m.place], env);
  assert.strictEqual(again.rc, 0, again.err);
  assert.strictEqual(again.n, 0, `la segunda ejecución cambió ${again.n}: ${again.out}`);
  assert.strictEqual(homeHash(h), hash, 'la segunda ejecución escribió algo');
});

// ── T21 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T21 Reroot_WithoutRenamesMap_OnlyExistingOption', () => {
  const C = clone('sin-mapa');
  const a = home('con-mapa'); const ma = machine(LAB, a, C, { plists: false });
  const b = home('sin-mapa'); const mb = machine(LAB, b, C, { plists: false });
  const withMap = reroot(a, ['--reroot', ma.legacy, ma.place, '--check']);
  const noMap = reroot(b, ['--reroot', mb.legacy, mb.place, '--check'], { TYCON_LEGACY_NAMES_MAP: path.join(LAB, 'no-hay-mapa.json') });
  assert.strictEqual(noMap.rc, 0, noMap.err);
  assert.ok(withMap.n > 0, withMap.out);
  assert.strictEqual(noMap.n, withMap.n, `sin el mapa: ${noMap.n}, con el mapa: ${withMap.n}`);
  // --only-existing: una ruta que no existe bajo <a> no se toca; la que existe sí
  const h = home('only-existing'); const m = machine(LAB, h, C, { plists: false });
  const s = readJson(m.files.settings);
  s.hooks.PreToolUse[0].hooks.push({ type: 'command', command: `node "${m.vals.LEGACY_SLASH}/scripts/hooks/no-existe.js"` });
  fs.writeFileSync(m.files.settings, JSON.stringify(s, null, 2));
  const r = reroot(h, ['--reroot', m.legacy, m.place, '--only-existing']);
  assert.strictEqual(r.rc, 0, r.err);
  const cmds = hookCommands(readJson(m.files.settings));
  assert.ok(cmds.some((c) => c.includes('no-existe.js') && legacyMentions(c) === 1), `tocó la ruta que no existe bajo <a>: ${cmds.join('\n')}`);
  assert.ok(cmds.some((c) => c.includes('lab-guard.js') && legacyMentions(c) === 0), `no tocó la que existe: ${cmds.join('\n')}`);
});

// ── T22 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T22 Reroot_Errors_TargetMissing_Unparseable_BinaryNoPlutil_Unwritable_Check_Usage', () => {
  const C = clone('errores');
  // <a> que no resuelve a una carpeta: 1, sin escribir
  const h1 = home('sin-destino'); const m1 = machine(LAB, h1, C, { plists: false });
  const hash1 = homeHash(h1);
  const r1 = reroot(h1, ['--reroot', m1.legacy, path.join(h1, '.claude', 'no-existe')]);
  assert.strictEqual(r1.rc, 1, `${r1.out}${r1.err}`);
  assert.match(r1.err, /no-existe/);
  assert.strictEqual(homeHash(h1), hash1, 'escribió con un <a> que no existe');
  // un archivo que no parsea: nombrado, no se toca, los demás siguen
  const h2 = home('no-parsea'); const m2 = machine(LAB, h2, C, { plists: false });
  fs.writeFileSync(m2.files.settings, '{ esto no es json');
  const r2 = reroot(h2, ['--reroot', m2.legacy, m2.place]);
  assert.strictEqual(r2.rc, 0, r2.err);
  assert.match(r2.out, /settings\.json.*no parsea/, r2.out);
  assert.strictEqual(fs.readFileSync(m2.files.settings, 'utf8'), '{ esto no es json');
  assert.strictEqual(legacyMentions(fs.readFileSync(m2.files.gitLocal, 'utf8')), 0, 'los demás no siguieron');
  // un plist binario sin plutil: nombrado, no se toca
  if (!IS_WIN) {
    const h3 = home('sin-plutil'); const m3 = machine(LAB, h3, C);
    const binBefore = fs.readFileSync(m3.files.plistBinary);
    const r3 = reroot(h3, ['--reroot', m3.legacy, m3.place], { PLUTIL_BIN: path.join(LAB, 'no-hay-plutil'), LAUNCHCTL_BIN: fakeLaunchctl(LAB, path.join(LAB, 'l3.log')) });
    assert.strictEqual(r3.rc, 0, r3.err);
    assert.match(r3.out, /lab-binary\.plist.*plutil/, r3.out);
    assert.ok(fs.readFileSync(m3.files.plistBinary).equals(binBefore), 'tocó el binario sin plutil');
    assert.strictEqual(legacyMentions(fs.readFileSync(m3.files.plistLoaded, 'utf8')), 0, 'los demás no siguieron');
  } else process.stdout.write('# ⏭ T22: el plist binario no aplica en Windows\n');
  // un archivo que no se puede respaldar: nombrado, no se toca, los demás siguen
  const h4 = home('sin-respaldo'); const m4 = machine(LAB, h4, C, { plists: false });
  const gitDir = path.dirname(m4.files.gitLocal);
  const gitBefore = fs.readFileSync(m4.files.gitLocal, 'utf8');
  let measured = false;
  if (!IS_WIN) {
    fs.chmodSync(gitDir, 0o555);
    try { fs.writeFileSync(path.join(gitDir, 'probe'), 'x'); fs.unlinkSync(path.join(gitDir, 'probe')); } catch (_) { measured = true; }
  }
  if (measured) {
    const r4 = reroot(h4, ['--reroot', m4.legacy, m4.place]);
    fs.chmodSync(gitDir, 0o755);
    assert.strictEqual(r4.rc, 0, r4.err);
    assert.match(r4.out, /pre-commit\.local.*no pude respaldarlo/, r4.out);
    assert.strictEqual(fs.readFileSync(m4.files.gitLocal, 'utf8'), gitBefore, 'tocó uno que no pudo respaldar');
    assert.strictEqual(legacyMentions(JSON.stringify(hookCommands(readJson(m4.files.settings)))), 0, 'los demás no siguieron');
  } else {
    if (!IS_WIN) fs.chmodSync(gitDir, 0o755);
    process.stdout.write('# ⏭ T22: NO MEDIDO — un archivo que no se puede respaldar (la carpeta de sólo lectura no frena en esta máquina)\n');
  }
  // --check: cuenta y no escribe
  const h5 = home('check'); const m5 = machine(LAB, h5, C, { plists: false });
  const hash5 = homeHash(h5);
  const r5 = reroot(h5, ['--reroot', m5.legacy, m5.place, '--check']);
  assert.strictEqual(r5.rc, 0, r5.err);
  assert.ok(r5.n > 0, r5.out);
  assert.strictEqual(homeHash(h5), hash5, '--check escribió');
  // --reroot con una sola ruta: 2, con el uso
  const r6 = reroot(h5, ['--reroot', m5.legacy]);
  assert.strictEqual(r6.rc, 2, `${r6.out}${r6.err}`);
  assert.match(r6.err, /--reroot <de> <a>/);
  assert.strictEqual(homeHash(h5), hash5);
});
