'use strict';

/**
 * bench-isolation.test.js — el examen de revisores arranca cada sesión sin la configuración del usuario: sólo con la
 * carpeta de la caja (el fixture y el corral de hermanos), en Claude y en Codex.
 *
 * El defecto que cierra: la sesión del examen heredaba del `settings.json` de Claude Code de la máquina sus carpetas
 * adicionales (y sus reglas y servidores), y de `~/.codex` el AGENTS.md global, los servidores MCP y las carpetas de
 * escritura extra. Un revisor que busca en todo lo que tiene al alcance leía rutas de la máquina, y el examen lo daba por
 * «fuga del corral» sin que el revisor razonara mal.
 *
 * Sin modelo ni red: una HOME y una CODEX_HOME de laboratorio, con lo que trae una máquina real.
 *
 * Uso: node --test scripts/tests/bench-isolation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const ISOLATION = path.join(RAIZ, 'scripts', 'controls-bench', 'isolation.js');
const RUNNER = path.join(RAIZ, 'scripts', 'controls-bench', 'advisor-runner.js');

/** Una HOME con el settings.json de una máquina de verdad: carpetas extra, reglas, servidores, ganchos y complementos. */
function homeDeMaquina() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-iso-home-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    permissions: { additionalDirectories: ['/srv/fuera-de-la-caja/Escritorio', '/tmp'], allow: ['Bash(*)'] },
    enabledPlugins: { 'engram@engram': true, 'telegram@claude-plugins-official': true },
    extraKnownMarketplaces: { engram: { source: { source: 'github', repo: 'acme/engram' } }, otro: { source: { source: 'github', repo: 'acme/otro' } } },
    mcpServers: { codegraph: { command: 'codegraph' } },
    hooks: { SessionStart: [] },
    effortLevel: 'xhigh',
  }));
  return home;
}

/** Una CODEX_HOME de una máquina de verdad. */
function codexDeMaquina() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-iso-codex-'));
  fs.writeFileSync(path.join(d, 'config.toml'), [
    '[mcp_servers.codegraph]', 'command = "codegraph"', '',
    '[sandbox_workspace_write]', 'writable_roots = ["/srv/fuera-de-la-caja/estado"]', '',
  ].join('\n'));
  fs.writeFileSync(path.join(d, 'AGENTS.md'), '# instrucciones globales con carpetas de la máquina\n');
  fs.writeFileSync(path.join(d, 'hooks.json'), '{}\n');
  fs.writeFileSync(path.join(d, 'auth.json'), '{"token":"de-prueba"}\n');
  fs.writeFileSync(path.join(d, 'tycon-x.config.toml'), 'model = "m"\n[mcp_servers.plugin_engram_engram]\ncommand = "engram"\n');
  return d;
}

test('Claude_SinConfiguracionDelUsuario — la sesión no carga el settings.json de la máquina; sólo engram y la caja', () => {
  const iso = require(ISOLATION);
  const home = homeDeMaquina();
  const r = iso.claudeIsolation({ home, corral: '/caja/corral' });
  const i = r.args.indexOf('--setting-sources');
  assert.ok(i >= 0, 'pasa --setting-sources');
  assert.ok(!r.args[i + 1].split(',').includes('user'), `sin la fuente user: ${r.args[i + 1]}`);
  assert.deepStrictEqual(r.args.slice(r.args.indexOf('--add-dir'), r.args.indexOf('--add-dir') + 2), ['--add-dir', '/caja/corral'], 'el corral es parte de la caja');
  const s = r.settings;
  assert.equal(s.permissions && s.permissions.additionalDirectories, undefined, 'sin las carpetas adicionales de la máquina');
  assert.equal(s.mcpServers, undefined, 'sin los servidores de la máquina');
  assert.equal(s.hooks, undefined, 'sin los ganchos de la máquina');
  assert.deepStrictEqual(s.enabledPlugins, { 'engram@engram': true }, 'sólo engram, que los casos usan');
  assert.deepStrictEqual(Object.keys(s.extraKnownMarketplaces || {}), ['engram'], 'y su mercado, para resolverlo');
  // sin engram en la máquina, nada que habilitar: no se inventa
  const vacia = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-iso-vacia-'));
  assert.deepStrictEqual(iso.claudeIsolation({ home: vacia }).settings.enabledPlugins, undefined);
});

test('Codex_SinConfiguracionDelUsuario — la sesión corre con una CODEX_HOME propia: el perfil y la llave, nada más', () => {
  const iso = require(ISOLATION);
  const real = codexDeMaquina();
  const c = iso.codexHome({ codexHome: real, advisor: 'tycon-x', engramDir: '/datos/engram' });
  try {
    assert.notStrictEqual(path.resolve(c.dir), path.resolve(real), 'no es la de la máquina');
    const nombres = fs.readdirSync(c.dir).sort();
    assert.deepStrictEqual(nombres, ['auth.json', 'config.toml', 'tycon-x.config.toml'], nombres.join(', '));
    assert.equal(fs.readFileSync(path.join(c.dir, 'auth.json'), 'utf8'), '{"token":"de-prueba"}\n', 'la llave para iniciar sesión');
    const base = fs.readFileSync(path.join(c.dir, 'config.toml'), 'utf8');
    assert.doesNotMatch(base, /codegraph|writable_roots|fuera-de-la-caja/, 'el config.toml base no trae nada de la máquina');
    const perfil = fs.readFileSync(path.join(c.dir, 'tycon-x.config.toml'), 'utf8');
    assert.match(perfil, /plugin_engram_engram/, 'el perfil del revisor, con su engram');
    // Codex no les pasa el entorno a sus servidores: engram recibe su carpeta de datos en el perfil
    assert.match(perfil, /\[mcp_servers\.plugin_engram_engram\.env\]\nENGRAM_DATA_DIR = "\/datos\/engram"/, 'engram guarda donde el examen mira');
    // la casa de la corrida: ni las skills de ~/.agents ni nada de la persona; engram, en los datos de la máquina
    assert.equal(c.env.CODEX_HOME, c.dir);
    assert.notStrictEqual(c.env.HOME, os.homedir(), 'un HOME de laboratorio');
    assert.deepStrictEqual(fs.readdirSync(c.env.HOME), [], 'vacío');
    assert.equal(c.env.ENGRAM_DATA_DIR, '/datos/engram', 'engram escribe donde el examen mira');
    // Codex renueva la llave durante la corrida: vuelve a la máquina
    fs.writeFileSync(path.join(c.dir, 'auth.json'), '{"token":"renovado"}\n');
  } finally { c.cleanup(); }
  assert.ok(!fs.existsSync(c.dir), 'se borra al terminar');
  assert.equal(fs.readFileSync(path.join(real, 'auth.json'), 'utf8'), '{"token":"renovado"}\n', 'la llave renovada vuelve a la máquina');
  // sin cambios en la llave, la de la máquina no se toca
  const otra = iso.codexHome({ codexHome: real, advisor: 'tycon-x' });
  const antes = fs.statSync(path.join(real, 'auth.json')).mtimeMs;
  otra.cleanup();
  assert.equal(fs.statSync(path.join(real, 'auth.json')).mtimeMs, antes, 'sin renovación, no se reescribe');
  // sin la llave, lo avisa
  fs.rmSync(path.join(real, 'auth.json'));
  const sinLlave = iso.codexHome({ codexHome: real, advisor: 'tycon-x' });
  assert.match(sinLlave.warning || '', /llave de Codex/);
  sinLlave.cleanup();
  // sin el perfil generado, lo dice: no corre con el config de la máquina
  assert.throws(() => iso.codexHome({ codexHome: real, advisor: 'tycon-sin-perfil' }), /perfil/);
});

test('Runner_UsaElAislamiento — el corredor lanza claude y codex con el aislamiento', () => {
  const src = fs.readFileSync(RUNNER, 'utf8');
  assert.match(src, /require\(['"]\.\/isolation\.js['"]\)/, 'el corredor carga isolation.js');
  // el lanzamiento de claude: sus argumentos llevan el aislamiento con el corral, y ninguno vuelve a nombrar la fuente user
  const lanzaClaude = /const args = \[\s*'-p', prompt,[\s\S]*?\];/.exec(src);
  assert.ok(lanzaClaude, 'encuentro los argumentos con que se lanza claude');
  assert.match(lanzaClaude[0], /\.\.\.claudeIsolation\(\{ corral \}\)\.args/, 'claude se lanza con el aislamiento y el corral');
  assert.doesNotMatch(src, /setting-sources['"]?\s*,\s*['"][^'"]*\buser\b/, 'nadie vuelve a pedir la fuente user');
  // el lanzamiento de codex: su CODEX_HOME es la temporal que arma codexHome, no la de la máquina
  assert.match(src, /home = codexHome\(\{ codexHome: CODEX_HOME, advisor: advisorName \}\)/, 'codex arma su CODEX_HOME propia');
  assert.match(src, /env: Object\.assign\(envDeCorrida\(corral\), home\.env\)/, 'y se la pasa a codex con su casa de laboratorio, no la de la máquina');
  assert.match(src, /finally \{ home\.cleanup\(\); \}/, 'y la borra en todos los caminos');
});
