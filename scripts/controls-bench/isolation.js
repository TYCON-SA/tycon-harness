'use strict';
/**
 * isolation.js — cada sesión del examen de revisores arranca sin la configuración del usuario: sólo con la carpeta de la
 * caja (el fixture, que es su cwd, y el corral de hermanos), en Claude y en Codex.
 *
 * POR QUÉ. Una sesión lanzada con la configuración de la máquina hereda lo que el dev tiene a mano: en Claude, las
 * carpetas adicionales del `~/.claude/settings.json`, sus reglas, sus servidores y sus ganchos; en Codex, el AGENTS.md
 * global, los servidores MCP y las carpetas de escritura extra de `~/.codex`. Un revisor que busca en todo lo que tiene al
 * alcance lee rutas de la máquina, y el examen lo cuenta como fuga del corral sin que el revisor razone mal. El veredicto
 * dependería de qué tiene cada máquina en el disco.
 *
 * QUÉ SE CONSERVA. De Claude, sólo el complemento engram (y su mercado, para resolverlo), que los casos con `expect_mcp` y
 * `expect_engram` usan. De Codex, la llave para iniciar sesión (`auth.json`) y el perfil generado del revisor, que ya trae
 * su servidor de engram con las herramientas que el revisor declara.
 *
 * Vive fuera de advisor-runner.js porque requerir el corredor arranca el examen entero: así se prueba sin modelo.
 * Casos: scripts/tests/bench-isolation.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ENGRAM_PLUGIN = /^engram@/;

/**
 * Las opciones y la configuración de una sesión de Claude del examen: `{ args, settings }`. `args` deja afuera la fuente
 * `user` y suma el corral como carpeta de la caja; `settings` trae sólo engram del settings.json de la máquina (lo demás
 * lo agrega quien llama: el esfuerzo, el encierro y el silencio).
 */
function claudeIsolation({ home = os.homedir(), corral = null } = {}) {
  const args = ['--setting-sources', 'project,local'];
  if (corral) args.push('--add-dir', corral);
  let user = {};
  let warning = null;
  const archivo = path.join(home, '.claude', 'settings.json');
  try { user = JSON.parse(fs.readFileSync(archivo, 'utf8')) || {}; }
  catch (e) {
    user = {};
    // sin el archivo no hay engram que habilitar; uno ilegible se dice: los casos que usan engram caerían sin motivo
    if (!(e && e.code === 'ENOENT')) warning = `no pude leer ${archivo} (${(e && e.code) || 'JSON inválido'}): el examen corre sin engram y los casos que lo usan van a fallar por eso, no por el revisor`;
  }
  const settings = {};
  const plugins = Object.entries(user.enabledPlugins || {}).filter(([k, v]) => ENGRAM_PLUGIN.test(k) && v);
  if (plugins.length) {
    settings.enabledPlugins = Object.fromEntries(plugins);
    const mercados = new Set(plugins.map(([k]) => k.split('@')[1]));
    const conocidos = Object.entries(user.extraKnownMarketplaces || {}).filter(([k]) => mercados.has(k));
    if (conocidos.length) settings.extraKnownMarketplaces = Object.fromEntries(conocidos);
  }
  return { args, settings, warning };
}

/**
 * Una casa propia para una corrida de Codex: `{ dir, env, warning, cleanup }`.
 *   · `dir` es la CODEX_HOME: el perfil `<revisor>.config.toml`, un `config.toml` vacío y `auth.json` (la llave);
 *   · `env` lleva esa CODEX_HOME, un HOME de laboratorio (así Codex no encuentra las skills de `~/.agents` ni nada de la
 *     casa de la persona), y la base y el puerto de engram que usa el examen (ENGRAM_DATA_DIR, ENGRAM_PORT: los de
 *     que el revisor guardó;
 *   · `cleanup` devuelve a la máquina la llave si Codex la renovó durante la corrida, y borra todo.
 * Tira si el perfil generado no está: sin él, el revisor correría con la configuración de la máquina.
 */
function codexHome({ codexHome: real = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), advisor, engramDir, engramPort } = {}) {
  const perfil = path.join(real, `${advisor}.config.toml`);
  if (!fs.existsSync(perfil)) throw new Error(`no está el perfil generado de ${advisor} (${perfil}): sin él, codex correría con la configuración de la máquina`);
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'advbench-codex-home-'));
  const dir = path.join(raiz, 'codex');
  const casa = path.join(raiz, 'casa');
  const authReal = path.join(real, 'auth.json');
  const authCorrida = path.join(dir, 'auth.json');
  let authAntes = null;
  const borrar = () => { try { fs.rmSync(raiz, { recursive: true, force: true }); } catch (_) { /* best-effort */ } };
  // si Codex renovó la llave (el archivo cambió), la renovada vuelve a la máquina antes de borrar: si no, la sesión de la
  // máquina podría quedar con un token que ya no vale
  const cleanup = () => {
    try {
      if (authAntes !== null && fs.existsSync(authCorrida)) {
        const ahora = fs.readFileSync(authCorrida);
        if (!ahora.equals(authAntes)) {
          const tmp = `${authReal}.advbench-${process.pid}`;
          fs.writeFileSync(tmp, ahora, { mode: 0o600 });
          fs.renameSync(tmp, authReal);
        }
      }
    } catch (_) { /* best-effort: la llave de la máquina queda como estaba */ }
    borrar();
  };
  let warning = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(casa, { recursive: true });
    // Codex no les pasa todo el entorno a sus servidores MCP: engram arrancaría con el HOME de laboratorio y guardaría
    // ahí. Su carpeta de datos se le declara en el perfil de la corrida, al servidor de engram que el perfil ya trae
    const datosEngram = engramDir || process.env.ENGRAM_DATA_DIR || path.join(os.homedir(), '.engram');
    const puertoEngram = engramPort || process.env.ENGRAM_PORT || null;
    let textoPerfil = fs.readFileSync(perfil, 'utf8');
    for (const m of textoPerfil.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]*engram[A-Za-z0-9_-]*)\]\s*$/gm)) {
      if (!new RegExp(`^\\[mcp_servers\\.${m[1]}\\.env\\]`, 'm').test(textoPerfil)) {
        textoPerfil += `\n[mcp_servers.${m[1]}.env]\nENGRAM_DATA_DIR = ${JSON.stringify(datosEngram)}\n${puertoEngram ? `ENGRAM_PORT = ${JSON.stringify(String(puertoEngram))}\n` : ''}`;
      }
    }
    fs.writeFileSync(path.join(dir, path.basename(perfil)), textoPerfil);
    fs.writeFileSync(path.join(dir, 'config.toml'), '# CODEX_HOME del examen de revisores: sin la configuración de la máquina (scripts/controls-bench/isolation.js)\n');
    if (fs.existsSync(authReal)) {
      authAntes = fs.readFileSync(authReal);
      fs.writeFileSync(authCorrida, authAntes, { mode: 0o600 });
    } else warning = `no está la llave de Codex (${authReal}): la ejecución va a fallar al iniciar sesión, no por el revisor`;
  } catch (e) { borrar(); throw e; }
  const env = {
    CODEX_HOME: dir, HOME: casa, USERPROFILE: casa,
    ENGRAM_DATA_DIR: engramDir || process.env.ENGRAM_DATA_DIR || path.join(os.homedir(), '.engram'),
    ...(engramPort || process.env.ENGRAM_PORT ? { ENGRAM_PORT: String(engramPort || process.env.ENGRAM_PORT) } : {}),
  };
  return { dir, env, warning, cleanup };
}

/**
 * La memoria de engram del examen: una base temporal y un puerto libre propios, para que ningún revisor lea ni escriba la
 * memoria de la máquina (donde las sesiones anotan sus rutas: un revisor que la consulta nombraría carpetas de la máquina).
 * `{ dir, port, env, anotarServidor(pid), cleanup }`: `env` va al entorno del corredor (lo heredan la línea de comandos de
 * engram, su servidor y los MCP de Claude; a Codex se le pasa en el perfil); `cleanup` mata el servidor que el examen
 * levantó y borra la base, y se puede llamar más de una vez.
 */
function engramPropio() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advbench-engram-'));
  const port = puertoLibre();
  const pids = [];
  let limpia = false;
  const cleanup = () => {
    for (const pid of pids.splice(0)) { try { process.kill(pid, 'SIGTERM'); } catch (_) { /* ya no está */ } }
    if (!limpia) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ } }
    limpia = !fs.existsSync(dir);
  };
  return { dir, port, env: { ENGRAM_DATA_DIR: dir, ENGRAM_PORT: String(port) }, anotarServidor: (pid) => { if (pid) pids.push(pid); }, cleanup };
}

/** Un puerto TCP libre de esta máquina (lo pide al sistema en un proceso aparte: la consulta es asíncrona en Node). */
function puertoLibre() {
  const r = require('child_process').spawnSync(process.execPath, ['-e',
    "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();})"],
  { encoding: 'utf8', timeout: 10000 });
  const p = Number(r.stdout);
  if (!Number.isInteger(p) || p <= 0) throw new Error(`no pude pedir un puerto libre para la memoria del examen (${(r.stderr || '').trim() || r.status})`);
  return p;
}

module.exports = { claudeIsolation, codexHome, engramPropio };
