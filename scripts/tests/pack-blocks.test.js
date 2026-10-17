'use strict';

/**
 * pack-blocks.test.js — las reglas siempre cargadas de un paquete (`packs/<p>/claude-md-blocks/*.md`).
 *
 * Qué sostiene: con el paquete activo para la organización (`packs.default`), su bloque queda en el CLAUDE.md (Mac y
 * Windows, el mismo texto byte a byte) y en el AGENTS.md de Codex, una sola vez aunque el sincronizador corra de nuevo; con
 * el paquete inactivo, o cuando el paquete ya no lo trae, se va y el archivo queda como si nunca hubiera estado; si no se
 * puede saber qué paquetes activa la organización, el bloque escrito queda y una línea lo dice; el reporte de piezas y el
 * plan lo nombran; la capa del equipo admite esos `.md` y nada más de esa carpeta.
 *
 * Cada caso arma un árbol de juguete (los lectores reales de scripts/lib y los sincronizadores reales, con un bloque del
 * núcleo de juguete y un paquete de juguete), con su propia carpeta de usuario y un perfil declarado (`TYCON_PROFILE`):
 * nunca lee la configuración de la máquina que corre la prueba.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEAM = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team.js'));

const W = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const R = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
const count = (text, s) => (text || '').split(s).length - 1;
const BLOCK = 'TYCON_BLOCK:packs/juguete/regla';
const PWSH = (() => { const r = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' }); return r.status === 0; })();

/** Un árbol de juguete con un bloque del núcleo y el paquete «juguete» con su regla; un perfil con `packs.default`. */
function lab(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-blocks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tree = path.join(dir, 'tree');
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(tree, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'scripts', 'setup'), { recursive: true });
  for (const f of ['sync-claude-md-blocks.sh', 'sync-claude-md-blocks.ps1', 'agents-md-blocks.js']) fs.copyFileSync(path.join(ROOT, 'scripts', 'setup', f), path.join(tree, 'scripts', 'setup', f));
  W(path.join(tree, 'claude-md-blocks', 'comun.md'), '# regla común\n\ncuerpo común\n');
  W(path.join(tree, 'packs', 'juguete', 'pack.json'), '{ "name": "juguete", "description": "un paquete de prueba" }\n');
  W(path.join(tree, 'packs', 'juguete', 'claude-md-blocks', 'regla.md'), '# regla del paquete\n\nsólo con el paquete activo\n');
  W(path.join(tree, 'packs', 'otro', 'pack.json'), '{ "name": "otro", "description": "otro paquete" }\n');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const perfil = path.join(dir, 'team-profile.json');
  const L = {
    dir, tree, home,
    claude: path.join(home, '.claude', 'CLAUDE.md'),
    agents: path.join(home, '.codex', 'AGENTS.md'),
    packs(value) { W(perfil, `${JSON.stringify({ packs: { default: value } })}\n`); },
    env(extra = {}) {
      return { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TYCON_PROFILE: perfil, TYCON_GUIDES_DIR: tree,
        CLAUDE_MD_PATH: L.claude, CODEX_AGENTS_MD_PATH: L.agents, TYCON_HARNESS_SNAPSHOT_DIR: path.join(dir, 'snap'), ...extra };
    },
    sh(args = [], extra = {}) { return spawnSync('bash', [path.join(tree, 'scripts', 'setup', 'sync-claude-md-blocks.sh'), ...args], { encoding: 'utf8', env: L.env(extra) }); },
    ps1(args = [], extra = {}) { return spawnSync('pwsh', ['-NoProfile', '-File', path.join(tree, 'scripts', 'setup', 'sync-claude-md-blocks.ps1'), ...args], { encoding: 'utf8', env: L.env(extra) }); },
    codex(args = []) { return spawnSync(process.execPath, [path.join(tree, 'scripts', 'setup', 'agents-md-blocks.js'), ...args], { encoding: 'utf8', env: L.env() }); },
  };
  L.packs(['juguete']);
  W(L.claude, 'lo mío, arriba\n');
  return L;
}

test('PackBlocks_Claude_ActivePackWrites_InactiveRemoves_FileAsBefore', (t) => {
  const L = lab(t);
  L.packs('none');
  L.sh();
  const sinPaquete = R(L.claude);
  assert.equal(count(sinPaquete, BLOCK), 0, 'sin el paquete activo, su regla no se escribe');
  L.packs(['juguete']);
  const r = L.sh();
  assert.match(r.stdout, /bloque CLAUDE\.md 'packs\/juguete\/regla' agregado/);
  const con = R(L.claude);
  assert.equal(count(con, `<!-- ${BLOCK} START`), 1, 'el bloque del paquete, una vez');
  assert.ok(con.includes('sólo con el paquete activo'), 'con su cuerpo');
  assert.ok(con.includes('editá packs/juguete/claude-md-blocks/regla.md'), 'la marca dice de qué archivo sale');
  assert.ok(con.startsWith('lo mío, arriba\n'), 'lo de la persona, intacto');
  L.sh();
  assert.equal(R(L.claude), con, 'correr otra vez no lo duplica ni lo cambia');
  L.packs('none');
  const chk = L.sh(['--check']);
  assert.match(chk.stdout, /'packs\/juguete\/regla' sobra \(el paquete «juguete» no está activo\)/);
  assert.equal(R(L.claude), con, '--check sólo mira');
  const q = L.sh();
  assert.match(q.stdout, /'packs\/juguete\/regla' quitado \(el paquete «juguete» no está activo\)/);
  assert.equal(R(L.claude), sinPaquete, 'sin el paquete, el archivo queda como si el bloque nunca hubiera estado');
});

test('PackBlocks_Claude_PackNoLongerBringsIt_Removed', (t) => {
  const L = lab(t);
  L.sh();
  assert.equal(count(R(L.claude), `<!-- ${BLOCK} START`), 1);
  fs.rmSync(path.join(L.tree, 'packs', 'juguete', 'claude-md-blocks'), { recursive: true });
  const r = L.sh();
  assert.match(r.stdout, /'packs\/juguete\/regla' quitado \(el paquete «juguete» ya no lo trae\)/);
  assert.equal(count(R(L.claude), BLOCK), 0);
});

test('PackBlocks_Claude_CannotKnowActivePacks_KeepsAndSays', (t) => {
  const L = lab(t);
  L.sh();
  const con = R(L.claude);
  L.packs(['no-instalado']);
  const r = L.sh();
  assert.match(r.stdout, /'packs\/juguete\/regla': no pude saber si su paquete está activo \(.*no-instalado.*\): queda donde está/);
  assert.equal(R(L.claude), con, 'no saber no es «inactivo»: el bloque queda');
});

test('PackBlocks_Claude_ProfileMarker_Obeyed', (t) => {
  const L = lab(t);
  W(path.join(L.tree, 'packs', 'juguete', 'claude-md-blocks', 'regla.md'), '<!-- requires-profile: full -->\n# regla del paquete\n\nsólo con el paquete activo\n');
  L.sh();
  const con = R(L.claude);
  assert.equal(count(con, `<!-- ${BLOCK} START`), 1, 'con el perfil full, el bloque del paquete');
  assert.ok(!con.includes('requires-profile'), 'el marcador no se copia');
  const r = L.sh([], { TYCON_INSTALL_PROFILE: 'minimal' });
  assert.match(r.stdout, /'packs\/juguete\/regla' quitado \(perfil «minimal»\)/, r.stdout + r.stderr);
  assert.equal(count(R(L.claude), BLOCK), 0);
});

test('PackBlocks_Claude_ReportAndPlanNameTheBlock', (t) => {
  const L = lab(t);
  const pieces = path.join(L.dir, 'pieces.tsv');
  L.sh([], { TYCON_REPORT_PIECES: pieces });
  assert.ok(R(pieces).split('\n').some((l) => l.endsWith(`\t${BLOCK}`) && l.startsWith('block\t')), `el reporte de piezas nombra el bloque: ${R(pieces)}`);
  L.packs('none');
  const plan = path.join(L.dir, 'plan.tsv');
  L.sh(['--check'], { TYCON_PLAN_PIECES: plan });
  assert.match(R(plan) || '', /^block\t[^\t]*CLAUDE\.md\tTYCON_BLOCK:packs\/juguete\/regla\tremove$/m, `el plan dice que lo saca: ${R(plan)}`);
});

test('PackBlocks_Claude_Windows_SameBytesAsMac', (t) => {
  if (!PWSH) { t.skip('NO MEDIDO: esta máquina no tiene pwsh (PowerShell 7)'); return; }
  const L = lab(t);
  const mac = path.join(L.dir, 'mac.md');
  // las dos implementaciones, desde el mismo punto de partida, con el paquete activo y después inactivo
  for (const value of [['juguete'], 'none']) {
    W(mac, 'lo mío, arriba\n'); W(L.claude, 'lo mío, arriba\n');
    L.packs(['juguete']); L.sh([], { CLAUDE_MD_PATH: mac }); L.ps1();
    L.packs(value); L.sh([], { CLAUDE_MD_PATH: mac }); const r = L.ps1();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(R(L.claude), R(mac), `Windows y Mac escriben lo mismo con packs.default=${JSON.stringify(value)}`);
    assert.equal(count(R(L.claude), `<!-- ${BLOCK} START`), value === 'none' ? 0 : 1);
    if (value === 'none') assert.match(r.stdout, /'packs\/juguete\/regla' quitado \(el paquete «juguete» no está activo\)/);
  }
});

test('PackBlocks_Codex_AppearsWithPack_GoesWithout', (t) => {
  const L = lab(t);
  L.codex();
  const con = R(L.agents);
  assert.equal(count(con, `<!-- ${BLOCK} START`), 1, 'el bloque del paquete en AGENTS.md');
  assert.ok(con.includes('sólo con el paquete activo'));
  L.codex();
  assert.equal(R(L.agents), con, 'idempotente');
  L.packs('none');
  const chk = L.codex(['--check']);
  assert.match(chk.stdout, /'packs\/juguete\/regla' sobra \(el paquete «juguete» no está activo\)/);
  const r = L.codex();
  assert.match(r.stdout, /'packs\/juguete\/regla' quitado/);
  assert.equal(count(R(L.agents), BLOCK), 0);
  assert.ok(R(L.agents).includes('TYCON_BLOCK:comun START'), 'el bloque del núcleo sigue');
});

test('PackBlocks_TeamLayer_AdmitsTopLevelMdOnly', () => {
  assert.equal(TEAM.layerPathProblem('packs/equipo-juguete/claude-md-blocks/bzurl.md'), null, 'la regla de un paquete entra a la capa');
  for (const p of ['packs/equipo-juguete/claude-md-blocks/sub/x.md', 'packs/equipo-juguete/claude-md-blocks/x.sh', 'packs/equipo-juguete/claude-md-blocks/CLAUDE.md', 'packs/equipo-juguete/claude-md-blocks/.x.md']) {
    assert.notEqual(TEAM.layerPathProblem(p), null, `${p} no entra`);
  }
});
