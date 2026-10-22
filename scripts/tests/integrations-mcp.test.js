'use strict';
/**
 * integrations-mcp.test.js — el servidor MCP que declara una integración, y lo que el núcleo lee de él.
 * stable-data: no crea commits ni lee el reloj.
 *
 * POR QUÉ. El despliegue de Codex decidía el servidor de la herramienta de horas por la llave vieja: con otra herramienta
 * elegida no avisaba nada, y el núcleo nombraba la herramienta. Ahora lo declara el manifiesto (`mcp`) y vale el de la
 * integración elegida.
 *
 * QUÉ MIDE. Que el despliegue registra, avisa o saca el servidor según la herramienta elegida, también con una que no
 * trae servidor (T65); y que las heurísticas de costo toman los servidores de las integraciones sin nombrarlos (T67).
 * Los nombres salen de los manifiestos, como en el árbol real. Nada toca el HOME real: cada casa es una carpeta temporal.
 *
 * Correr:   node --test scripts/tests/integrations-mcp.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DCM = require(path.join(ROOT, 'build', 'deploy-codex-mcp.js'));
const EQ = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'equivalences.json'), 'utf8'));
// la integración de horas que declara un servidor de cada máquina, y una de horas sin servidor
const WITH = DCM.integrationMcps().find((e) => e.machine && e.kind === 'timeTracking');
const INT = require(path.join(ROOT, 'scripts', 'lib', 'integrations.js'));
const WITHOUT = INT.listManifests({ dir: path.join(ROOT, 'integrations') }).manifests.find((m) => m.kind === 'timeTracking' && !m.mcp);

function casa() { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-home-')); fs.mkdirSync(path.join(h, '.claude'), { recursive: true }); return h; }
function deploy(home, codex, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_PROFILE: '0', CODEX_HOME: codex, ...extra };
  for (const k of ['TYCON_TIME_TRACKING', 'TYCON_CLOCKIFY', 'TYCON_INTEGRATIONS_DIR']) if (!(k in extra)) delete env[k];
  return spawnSync(process.execPath, [path.join(ROOT, 'build', 'deploy-codex-mcp.js')], { env, encoding: 'utf8' });
}

test('T65 Mcp_FromChosenIntegration_SolidtimeExpectsNone @story-7.40 @ac-31', () => {
  assert.ok(WITH, 'una integración de horas declara su servidor MCP de cada máquina');
  assert.ok(WITHOUT, 'y otra de horas no trae servidor');
  const S = WITH.server;
  assert.ok(DCM.OWN_LABELS.includes(S), 'el servidor de la integración es del arnés');
  const claude = { mcpServers: { [S]: { command: '/opt/x/node', args: ['/opt/x/srv.js'], env: {} } } };
  const has = () => true;
  // se registra con su herramienta elegida; con otra, o sin ninguna, no
  assert.ok(DCM.resolveServers(claude, EQ, { timeTracking: WITH.integration }, has).servers[S]);
  assert.ok(!DCM.resolveServers(claude, EQ, { timeTracking: WITHOUT.name }, has).servers[S]);
  assert.ok(!DCM.resolveServers(claude, EQ, { timeTracking: 'none' }, has).servers[S]);
  // la llave vieja sola ya no decide: lo que manda es la elegida
  assert.ok(!DCM.resolveServers(claude, EQ, { [WITH.integration]: true, timeTracking: WITHOUT.name }, has).servers[S]);
  // sin servidor en la máquina: se dice si es la elegida, y con la otra no se espera nada
  const falta = DCM.missingServers({ integrations: { timeTracking: WITH.integration }, servers: {}, claudeJson: 'missing', has, target: '/c/config.toml' });
  assert.ok(falta.some((l) => l.includes(`«${S}»`) && /no lo puedo registrar/.test(l) && /timeTracking/.test(l)), falta.join('\n'));
  assert.ok(!DCM.missingServers({ integrations: { timeTracking: WITHOUT.name }, servers: {}, claudeJson: 'missing', has, target: 't' }).some((l) => l.includes(`«${S}»`)));
  // de punta a punta: la tabla escrita a mano se saca con la otra herramienta y queda con la suya
  const home = casa();
  const codex = path.join(home, '.codex');
  fs.mkdirSync(codex, { recursive: true });
  const toml = `[mcp_servers]\n\n[mcp_servers.${S}]\ncommand = "mio"\nargs = []\n`;
  fs.writeFileSync(path.join(codex, 'config.toml'), toml);
  const otra = deploy(home, codex, { TYCON_TIME_TRACKING: WITHOUT.name });
  assert.strictEqual(otra.status, 0, otra.stderr);
  assert.ok(!fs.readFileSync(path.join(codex, 'config.toml'), 'utf8').includes(`[mcp_servers.${S}]`), 'con la otra herramienta, la tabla sale');
  fs.writeFileSync(path.join(codex, 'config.toml'), toml);
  const suya = deploy(home, codex, { TYCON_TIME_TRACKING: WITH.integration });
  assert.strictEqual(suya.status, 0, suya.stderr);
  assert.ok(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8').includes(`[mcp_servers.${S}]`), 'con la suya, la tabla a mano queda');
  assert.ok(!suya.stdout.includes(`«${S}»`), `registrado a mano: no se avisa (${suya.stdout})`);
});

test('T65b Mcp_BrokenOrClashing_IsReportedNotTaken @story-7.40 @ac-31', () => {
  // un árbol con la biblioteca real y unas integraciones de mentira
  const tcg = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tcg-'));
  fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(tcg, 'scripts'), 'dir');
  const man = (dir, m) => { fs.mkdirSync(path.join(tcg, 'integrations', dir), { recursive: true }); fs.writeFileSync(path.join(tcg, 'integrations', dir, 'integration.json'), JSON.stringify({ name: dir, label: dir, hooks: [], dispatch: [], skills: [], settings: [], ...m })); };
  man('instincts', { kind: 'toggle', mcp: { server: 'srv-t', machine: true } });
  man('hz', { kind: 'timeTracking', mcp: { server: 'srv-a', machine: true } });
  man('h1', { kind: 'timeTracking', mcp: { server: 'srv-a', machine: true } });
  man('h2', { kind: 'timeTracking', mcp: { server: 'spokenly', machine: true } });
  man('h3', { kind: 'timeTracking', mcp: { server: 'bad name', machine: true } });
  man('h4', { kind: 'timeTracking', mcp: { server: 'srv-d', machine: false } });
  man('h5', { kind: 'timeTracking', mcp: 'srv-e' });
  // de un tipo que el despliegue no sabe prender, se rechaza; `null` es «sin servidor», no un manifiesto roto
  man('h6', { kind: 'notify', mcp: { server: 'srv-n', machine: true } });
  man('h7', { kind: 'timeTracking', mcp: null });
  const problems = [];
  const got = DCM.integrationMcps(tcg, problems);
  // se toma sólo el primero de cada servidor; el que choca con uno fijo, el duplicado y los rotos se dicen
  assert.deepStrictEqual(got.map((e) => e.integration), ['h1', 'instincts'], JSON.stringify(got));
  const text = problems.join('\n');
  for (const n of ['hz', 'h2', 'h3', 'h4', 'h5', 'h6']) assert.ok(text.includes(`«${n}»`), `${n} no se dijo:\n${text}`);
  assert.ok(!text.includes('«h7»'), `«mcp»: null es «sin servidor»:\n${text}`);
  assert.ok(/srv-a/.test(text) && /spokenly/.test(text), text);
  // la de prender y apagar va por su llave; la de horas, por la elegida; sin configuración, prendida
  const tog = got[1];
  assert.strictEqual(DCM.mcpOn(tog, { instincts: true }), true);
  assert.strictEqual(DCM.mcpOn(tog, { instincts: false, timeTracking: 'instincts' }), false);
  assert.strictEqual(DCM.mcpOn(tog, null), true);
  assert.strictEqual(DCM.mcpOn({ integration: 'h1', kind: 'timeTracking' }, { h1: true, timeTracking: 'none' }), false);
  // sin la biblioteca: ninguno, y se dice
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tcg-'));
  const p2 = [];
  assert.deepStrictEqual(DCM.integrationMcps(empty, p2), []);
  assert.ok(/no pude leer las integraciones/.test(p2.join('')), p2.join(''));
});

test('T65c Mcp_ConfigCannotSayTool_RemovesNothing @story-7.40 @ac-31', () => {
  // un árbol con el despliegue real y un lector de configuración que no sabe decir la herramienta de horas
  const tcg = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tcg-'));
  fs.mkdirSync(path.join(tcg, 'build'));
  fs.mkdirSync(path.join(tcg, 'scripts', 'lib'), { recursive: true });
  for (const f of ['deploy-codex-mcp.js', 'equivalences.json']) fs.copyFileSync(path.join(ROOT, 'build', f), path.join(tcg, 'build', f));
  fs.symlinkSync(path.join(ROOT, 'scripts', 'lib', 'integrations.js'), path.join(tcg, 'scripts', 'lib', 'integrations.js'));
  fs.symlinkSync(path.join(ROOT, 'integrations'), path.join(tcg, 'integrations'), 'dir');
  fs.writeFileSync(path.join(tcg, 'scripts', 'lib', 'tycon-config.js'), "module.exports = { leer: () => ({}), integraciones: () => ({}) };\n");
  const home = casa();
  const codex = path.join(home, '.codex');
  fs.mkdirSync(codex, { recursive: true });
  const S = WITH.server;
  fs.writeFileSync(path.join(codex, 'config.toml'), `[mcp_servers]\n\n[mcp_servers.${S}]\ncommand = "mio"\nargs = []\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_PROFILE: '0', CODEX_HOME: codex };
  for (const k of ['TYCON_TIME_TRACKING', 'TYCON_CLOCKIFY', 'TYCON_INTEGRATIONS_DIR']) delete env[k];
  const r = spawnSync(process.execPath, [path.join(tcg, 'build', 'deploy-codex-mcp.js')], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  // sin saber cuál es la elegida, la tabla del servidor de la integración queda
  assert.ok(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8').includes(`[mcp_servers.${S}]`), r.stdout);
  assert.ok(/no pude leer qué integraciones están prendidas/.test(r.stdout), `se dice: ${r.stdout}`);
});

test('T65d Mcp_OwnTableWithCommentOrSubtables_IsReplacedOrRemovedWhole @story-7.40 @ac-31', () => {
  const S = WITH.server;
  const conComentario = `[mcp_servers]\n\n[mcp_servers.${S}] # a mano\ncommand = "c"\nargs = []\n`;
  // con el comentario al final: prendida, una sola tabla (la nueva); con otra herramienta, sale
  const prendida = DCM.spliceToml(conComentario, { [S]: { command: 'new', args: [] } }, []);
  assert.strictEqual(prendida.split('\n').filter((l) => l.startsWith(`[mcp_servers.${S}]`)).length, 1, prendida);
  assert.ok(prendida.includes('command = "new"') && !prendida.includes('command = "c"'), prendida);
  assert.ok(!DCM.spliceToml(conComentario, {}, [S]).includes(`[mcp_servers.${S}]`));
  // con subtablas más hondas: al sacarlo, sale entero; al reescribirlo, la aprobación de cada herramienta queda
  const conHerramientas = `[mcp_servers]\n\n[mcp_servers.${S}]\ncommand = "c"\n\n[mcp_servers.${S}.env]\nA = "1"\n\n[mcp_servers.${S}.tools.foo]\napproval_mode = "approve"\n`;
  assert.ok(!DCM.spliceToml(conHerramientas, {}, [S]).includes(`mcp_servers.${S}`), DCM.spliceToml(conHerramientas, {}, [S]));
  const reescrita = DCM.spliceToml(conHerramientas, { [S]: { command: 'new', args: [] } }, []);
  assert.ok(reescrita.includes(`[mcp_servers.${S}.tools.foo]`) && !reescrita.includes('A = "1"'), reescrita);
  assert.strictEqual(reescrita.split('\n').filter((l) => l === `[mcp_servers.${S}]`).length, 1, reescrita);
  // el nombre de una herramienta entre comillas, con espacios, también es del servidor
  const conComillas = `[mcp_servers]\n\n[mcp_servers.${S}]\ncommand = "c"\n\n[mcp_servers.${S}.tools."a b"]\napproval_mode = "approve"\n`;
  assert.ok(!DCM.spliceToml(conComillas, {}, [S]).includes(`mcp_servers.${S}`), DCM.spliceToml(conComillas, {}, [S]));
  // un servidor propio que no es de la máquina y no se resolvió sale entero, sin dejar subtablas huérfanas
  const fijo = DCM.OWN_LABELS.find((l) => !DCM.integrationMcps().some((e) => e.server === l) && l !== 'spokenly');
  const sinResolver = DCM.spliceToml(`[mcp_servers]\n\n[mcp_servers.${fijo}]\ncommand = "c"\n\n[mcp_servers.${fijo}.tools.y]\napproval_mode = "approve"\n`, {}, []);
  assert.ok(!sinResolver.includes(`mcp_servers.${fijo}`), sinResolver);
  // una tabla ajena con un nombre parecido no se toca
  assert.ok(DCM.spliceToml(`[mcp_servers]\n\n[mcp_servers.${S}x]\ncommand = "z"\n`, {}, [S]).includes(`[mcp_servers.${S}x]`));
});

test('T67 ContextCost_NoToolNames @story-7.40 @ac-33', () => {
  // el servidor de una integración cuenta como del arnés y con la cantidad de herramientas por defecto
  const home = casa();
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ mcpServers: { [WITH.server]: { command: 'x' } } }));
  const r = spawnSync(process.execPath, ['-e', `const c=require(${JSON.stringify(path.join(ROOT, 'scripts', 'tools', 'context-budget.js'))});process.stdout.write(JSON.stringify(c.inventoryMCPs()))`], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const all = JSON.stringify(JSON.parse(r.stdout));
  const inv = JSON.parse(r.stdout);
  const list = Array.isArray(inv) ? inv : (inv.servers || inv.mcps || Object.values(inv).find(Array.isArray) || []);
  const e = list.find((x) => x && x.name === WITH.server);
  assert.ok(e, all.slice(0, 300));
  assert.strictEqual(e.isCore, true, 'el servidor de una integración es del arnés');
  // el control de los nombres no cuenta nada en esos archivos
  const TN = require(path.join(ROOT, 'scripts', 'ci', 'tool-names.js'));
  const { perFile } = TN.check({ repo: ROOT });
  for (const f of ['scripts/tools/context-budget.js', 'scripts/lib/harness-audit.js', 'build/deploy-codex-mcp.js']) assert.ok(!perFile[f], `${f} todavía nombra la herramienta (${perFile[f]})`);
});
