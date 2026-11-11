'use strict';
// prepare-machine.test.js — the guided step a dev runs once before working with a coordinator. It only reads and says: what is missing, one line each, with the exact command for that person. Nothing
// here reads the real HOME: every case builds its own HOME, profile, repos and fake system root.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'tools', 'prepare-machine.js');
const PM = require(SCRIPT);

// A toy machine: HOME, the harness with its team profile, a fake system root and a git repo.
function toy({ profile = {}, settings = { skipDangerousModePermissionPrompt: true }, claudeJson = {}, prod = null } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (settings) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  if (claudeJson !== null) fs.writeFileSync(path.join(home, '.claude.json'), typeof claudeJson === 'string' ? claudeJson : JSON.stringify(claudeJson));
  const arnes = path.join(root, 'arnes');
  fs.mkdirSync(arnes);
  fs.writeFileSync(path.join(arnes, 'perfil-equipo.json'), JSON.stringify(profile));
  const sysRoot = path.join(root, 'sys');
  if (prod && prod.permission) {
    fs.mkdirSync(path.join(sysRoot, 'opt', 'tycon', 'production'), { recursive: true });
    fs.writeFileSync(path.join(sysRoot, 'opt', 'tycon', 'production', 'auto-update.json'), '{}');
  }
  const judgeGuard = () => (prod ? { autorizada: true, viejo: !!prod.viejo, avisos: prod.avisos || (prod.viejo ? ['🔴 el freno quedó viejo: reinstalalo'] : []) } : { autorizada: false, viejo: false, avisos: [] });
  const opts = { home, arnes, env: {}, platform: 'darwin', prodRoot: sysRoot, judgeGuard };
  return { root, home, arnes, sysRoot, opts };
}
function repo(t, name, { claudeMd = null } = {}) {
  const dir = path.join(t.root, 'src', name);
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', dir]);
  if (claudeMd != null) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd);
  return dir;
}
const trusted = (...dirs) => ({ projects: Object.fromEntries(dirs.map((d) => [d, { hasTrustDialogAccepted: true }])) });
const text = (r) => PM.render(r);

test('8.187 T8 Preparar_DiceLoQueFalta_ConSuComando @story-8.187 @ac-7: una línea por cosa, con su comando y las comillas de cada sistema; sin relay_session no pide confirmar la coordinadora', () => {
  const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } }, settings: {}, prod: { viejo: true } });
  const r1 = repo(t, "proyecto o'uno");
  // el archivo importado existe: Claude Code sólo pregunta por un import que puede cargar
  fs.mkdirSync(path.join(t.home, 'afuera'));
  fs.writeFileSync(path.join(t.home, 'afuera', 'guia.md'), '# guía\n');
  const r2 = repo(t, 'con-imports', { claudeMd: '# x\n@~/afuera/guia.md\n' });
  fs.writeFileSync(path.join(t.home, '.claude.json'), JSON.stringify({ projects: { [r2]: { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false } } }));
  const r = PM.check({ ...t.opts, repos: [r1, r2] });
  assert.strictEqual(r.code, 1);
  const out = text(r);
  // el freno, la coordinadora, la advertencia del modo sin permisos, la carpeta sin aprobar y los imports
  assert.match(out, /freno/i);
  assert.match(out, /coordinadora/i);
  assert.match(out, /confirm-designation/);
  assert.match(out, /sin permisos/i);
  assert.match(out, /--permission-mode bypassPermissions/);
  assert.ok(out.includes(`cd '${r1.replace(/'/g, "'\\''")}' && claude`), out);
  assert.match(out, /imports/i);
  assert.ok(out.includes(`cd '${r2}' && claude`), out);
  assert.strictEqual(r.items.filter((i) => !i.ok).length, 5, out);
  for (const i of r.items.filter((x) => !x.ok)) assert.ok(i.command, `${i.text} trae su comando`);
  // Windows: las comillas de PowerShell
  const w = text(PM.check({ ...t.opts, platform: 'win32', repos: [r1] }));
  assert.ok(w.includes(`Set-Location -LiteralPath '${r1.replace(/'/g, "''")}'; claude`), w);
  // sin approvals.relay_session la coordinadora no firma: no se pide confirmarla
  const sin = toy({ profile: {}, settings: {}, prod: null });
  const out2 = text(PM.check({ ...sin.opts, repos: [] }));
  assert.doesNotMatch(out2, /confirm-designation/);
});

test('8.187 T9 Preparar_ConTodoHecho_DiceLista @story-8.187 @ac-8: con todo hecho dice «lista» y sale 0; un repo sin imports externos no queda pendiente', () => {
  const t = toy({ profile: {} });
  const a = repo(t, 'a', { claudeMd: '# a\n@docs/interno.md\n' });
  const b = repo(t, 'b');
  fs.writeFileSync(path.join(t.home, '.claude.json'), JSON.stringify({ projects: { [a]: { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false }, [b]: { hasTrustDialogAccepted: true } } }));
  const r = PM.check({ ...t.opts, repos: [a, b] });
  assert.strictEqual(r.code, 0, text(r));
  assert.match(text(r), /\blista\b/);
  // volver a correrlo comprueba de nuevo y dice lo mismo
  assert.strictEqual(PM.check({ ...t.opts, repos: [a, b] }).code, 0);
});

// Every file under a folder, with its content hash and its modification time.
function fingerprint(dir) {
  const out = {};
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[p] = `${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')} ${fs.statSync(p).mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

test('8.187 T10 Preparar_NoEscribeNadaNiLlamaASudo @story-8.187 @ac-9: no escribe nada, no acepta nada y no llama a sudo, con el juicio real del freno', () => {
  const t = toy({ profile: { approvals: { relay_session: 'coordinadora' }, guard: { update: 'auto' } }, settings: {} });
  const r1 = repo(t, 'uno', { claudeMd: '@/etc/afuera.md\n' });
  const bin = path.join(t.root, 'bin');
  fs.mkdirSync(bin);
  const sudoLog = path.join(t.root, 'sudo.log');
  // printf, not echo: on Linux /bin/sh is dash, whose echo takes a leading -n as its own option
  fs.writeFileSync(path.join(bin, 'sudo'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sudoLog}'\nexit 0\n`, { mode: 0o755 });
  const before = fingerprint(t.root);
  const cli = spawnSync(process.execPath, [SCRIPT, '--repo', r1], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: t.home, USERPROFILE: t.home, TYCON_HARNESS_DIR: t.arnes, TYCON_PROD_ROOT: t.sysRoot },
  });
  assert.ok([0, 1, 2].includes(cli.status), cli.stderr);
  assert.ok(!fs.existsSync(sudoLog), 'no llamó a sudo');
  assert.deepStrictEqual(fingerprint(t.root), before, 'no escribió nada');
});

test('8.187 T11 Preparar_FrenoViejo_SegunGuardUpdate @story-8.187 @ac-10: con auto y el permiso, el comando sin contraseña; sin auto, el de la contraseña y que la organización puede elegir; sin producción, nada', () => {
  const auto = toy({ profile: { guard: { update: 'auto' } }, prod: { viejo: true, permission: true } });
  // la versión nueva llegó hace un rato: la actualización sola todavía puede arrancar
  // stable-data: la fecha de la bajada tiene que ser de hace menos de 24 h para que sea el caso «se está actualizando»
  fs.writeFileSync(path.join(auto.arnes, '.tycon-release.json'), JSON.stringify({ commit: 'b'.repeat(40), version: 'v-b', downloaded_at: new Date().toISOString() }));
  const a = text(PM.check({ ...auto.opts, repos: [] }));
  assert.match(a, /sudo -n \/opt\/tycon\/setup\/update-guard\.sh/);
  assert.doesNotMatch(a, /contraseña/);
  const pw = toy({ profile: { guard: { update: 'password' } }, prod: { viejo: true } });
  const p = text(PM.check({ ...pw.opts, repos: [] }));
  assert.ok(p.includes(`sudo bash '${path.join(pw.arnes, 'scripts', 'production', 'install-guard.sh')}'`), p);
  assert.match(p, /contraseña/);
  assert.match(p, /guard\.update/);
  const none = toy({ profile: { guard: { update: 'auto' } }, prod: null });
  const n = text(PM.check({ ...none.opts, repos: [] }));
  assert.doesNotMatch(n, /freno|install-guard|update-guard/i);
  // los otros avisos del freno se muestran tal cual, sin perder ninguno
  const half = toy({ prod: { viejo: false, avisos: ['🔴 el freno está instalado A MEDIAS: falta la puerta. Reinstalalo: open x'] } });
  assert.match(text(PM.check({ ...half.opts, repos: [] })), /A MEDIAS: falta la puerta/);
});

test('8.187 T14 Preparar_ConfigIlegible_NoSabe @story-8.187 @ac-13: con ~/.claude.json roto dice «no pude saber» por cada carpeta y nunca «lista»', () => {
  const t = toy({ claudeJson: '{ roto' });
  const a = repo(t, 'a');
  const b = repo(t, 'b');
  const r = PM.check({ ...t.opts, repos: [a, b] });
  assert.strictEqual(r.code, 2);
  const out = text(r);
  assert.strictEqual((out.match(/no pude saber si está aprobada/g) || []).length, 2, out);
  assert.doesNotMatch(out, /\blista\b/);
});

test('8.187 T15 Preparar_RepoQueNoExiste_SigueConLosDemas @story-8.187 @ac-14: una carpeta mala se dice en su línea y sigue con las demás', () => {
  const t = toy();
  const good = repo(t, 'bueno');
  const missing = path.join(t.root, 'no-esta');
  const notRepo = path.join(t.root, 'suelta');
  fs.mkdirSync(notRepo);
  const r = PM.check({ ...t.opts, repos: [missing, notRepo, good] });
  const out = text(r);
  assert.ok(out.includes(missing), out);
  assert.ok(out.includes(notRepo), out);
  assert.ok(out.includes(good), out);
  assert.notStrictEqual(r.code, 0);
});

test('8.187 T28 Preparar_YGuia_DanElComandoDelPermiso @story-8.187 @ac-25: con auto en el perfil y sin el permiso en la máquina da el comando exacto, y no lo corre', () => {
  const t = toy({ profile: { guard: { update: 'auto' } }, prod: { viejo: false } });
  const out = text(PM.check({ ...t.opts, repos: [] }));
  assert.ok(out.includes(`sudo bash '${path.join(t.arnes, 'scripts', 'production', 'install-guard.sh')}' --allow-auto-update`), out);
  assert.match(out, /contraseña/);
  const guide = fs.readFileSync(path.join(ROOT, 'guides', 'produccion-con-permiso.md'), 'utf8');
  assert.match(guide, /install-guard\.sh --allow-auto-update/);
  assert.match(guide, /guard\.update: auto/);
});

test('8.187 T11b Preparar_FrenoViejo_QuePideContrasena_DaEseComando @story-8.187 @ac-10: con auto y el permiso, si el aviso del freno dice que hace falta la contraseña (trabado, falla, otro instalador), da el comando con contraseña y no el sin contraseña', () => {
  const t = toy({ profile: { guard: { update: 'auto' } }, prod: { viejo: true, permission: true } });
  // sin fecha de bajada cuenta como más de 24 h: la actualización sola está trabada
  const out = text(PM.check({ ...t.opts, repos: [] }));
  assert.ok(out.includes(`sudo bash '${path.join(t.arnes, 'scripts', 'production', 'install-guard.sh')}'`), out);
  assert.match(out, /trabada/);
  assert.doesNotMatch(out, /sudo -n/);
});

test('8.187 T9b Preparar_ImportsExternos_ComoLosVeClaudeCode @story-8.187 @ac-7 @ac-8: cuenta los anidados y los de .claude/rules; no cuenta los de un bloque de código, un comentario, una ruta dentro del repo ni un archivo que no existe', () => {
  const t = toy();
  const afuera = path.join(t.root, 'afuera.md');
  fs.writeFileSync(afuera, '# afuera\n');
  const nested = repo(t, 'anidado', { claudeMd: '# x\n@docs/a.md\n' });
  fs.mkdirSync(path.join(nested, 'docs'));
  fs.writeFileSync(path.join(nested, 'docs', 'a.md'), `@${path.relative(path.join(nested, 'docs'), afuera)}\n`);
  assert.strictEqual(PM.hasExternalImports(nested, t.home), true, 'un import anidado que sale del repo');
  const rules = repo(t, 'reglas');
  fs.mkdirSync(path.join(rules, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(rules, '.claude', 'rules', 'r.md'), `@${afuera}\n`);
  assert.strictEqual(PM.hasExternalImports(rules, t.home), true, 'un import de .claude/rules');
  const code = repo(t, 'codigo', { claudeMd: `# x\n\n\`\`\`\n@${afuera}\n\`\`\`\n\nen línea \`@${afuera}\`\n<!-- @${afuera} -->\n` });
  assert.strictEqual(PM.hasExternalImports(code, t.home), false, 'dentro de código o de un comentario no es import');
  const inside = repo(t, 'adentro');
  fs.writeFileSync(path.join(inside, 'guia.md'), '# g\n');
  fs.writeFileSync(path.join(inside, 'CLAUDE.md'), `@${path.join(inside, 'guia.md')}\n`);
  assert.strictEqual(PM.hasExternalImports(inside, t.home), false, 'una ruta absoluta dentro del repo');
  const missing = repo(t, 'falta', { claudeMd: '@~/no-existe/guia.md\n' });
  assert.strictEqual(PM.hasExternalImports(missing, t.home), false, 'un archivo que no existe no se importa');
});

test('8.187 T9c Preparar_ImportsRechazados_NoLosPidePorSiempre @story-8.187 @ac-8: imports que la persona ya rechazó no se piden otra vez (Claude Code no vuelve a preguntar); la máquina puede quedar lista', () => {
  const t = toy();
  const afuera = path.join(t.root, 'afuera.md');
  fs.writeFileSync(afuera, '# afuera\n');
  const r1 = repo(t, 'rechazados', { claudeMd: `@${afuera}\n` });
  fs.writeFileSync(path.join(t.home, '.claude.json'), JSON.stringify({ projects: { [r1]: { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true } } }));
  const r = PM.check({ ...t.opts, repos: [r1] });
  assert.strictEqual(r.code, 0, text(r));
  assert.match(text(r), /lista/);
  assert.match(text(r), /rechazaste/);
});

test('8.187 T15b Preparar_LoQueNoPudoMirar_NoEsLoQueFalta @story-8.187 @ac-13: un aviso del freno de «no pude» y un CLAUDE.md ilegible salen como «no pude mirar» (2); los renglones de continuación van con su aviso', { skip: process.platform === 'win32' ? 'permisos POSIX' : false }, () => {
  const t = toy({ prod: { viejo: false, avisos: ['🔴 el FRENO de producción no está instalado', '   Instalalo (pide tu contraseña del Mac, una vez): open x'] } });
  const r = PM.check({ ...t.opts, repos: [] });
  assert.strictEqual(r.code, 1, text(r));
  assert.strictEqual(r.items.length, 1, text(r));
  assert.match(r.items[0].text, /no está instalado.*Instalalo/);
  const t2 = toy({ prod: { viejo: false, avisos: ['🟠 no pude comparar contra lo publicado: el freno'] } });
  assert.strictEqual(PM.check({ ...t2.opts, repos: [] }).code, 2);
  const t3 = toy();
  const r3 = repo(t3, 'ilegible');
  fs.mkdirSync(path.join(r3, 'CLAUDE.md'));
  assert.strictEqual(PM.hasExternalImports(r3, t3.home), null);
  fs.writeFileSync(path.join(t3.home, '.claude.json'), JSON.stringify(trusted(r3)));
  const c = PM.check({ ...t3.opts, repos: [r3] });
  assert.strictEqual(c.code, 2, text(c));
  assert.match(text(c), /no pude leer/);
});

test('8.187 T15c Preparar_UnaParteQueSeCae_NoTiraAbajoLoDemas @story-8.187 @ac-13: si mirar el freno o la coordinadora lanza, lo dice como «no pude mirar» y sigue', () => {
  const t = toy();
  const r = PM.check({ ...t.opts, judgeGuard: () => { throw new Error('sin lector'); }, repos: [] });
  assert.strictEqual(r.code, 2);
  assert.match(text(r), /no pude saber si el freno.*sin lector/);
});
