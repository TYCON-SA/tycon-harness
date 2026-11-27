'use strict';
// command-readers.test.js — el lector de los comandos de una plataforma vive en su conector, y el núcleo lo busca por el
// programa que lee, sin nombrar la plataforma.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CARGADOR = path.join(ROOT, 'scripts', 'lib', 'command-readers.js');
const USAN = ['scripts/hooks/pr-auto-complete-guard.js', 'scripts/hooks/pr-one-per-repo-guard.js', 'scripts/hooks/public-push-guard.js',
  'scripts/hooks/retro-pending.js', 'scripts/lib/ci-bypass.js', 'scripts/lib/external-pr.js'];
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('CommandReaders_ElLectorDeGhViveEnSuConector: el núcleo lo busca por el programa y quien lo usa no nombra su ruta', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'gh-pr.js')), 'ya no está en el núcleo');
  const C = require(CARGADOR);
  const gh = C.lectorDe('gh');
  for (const f of ['comandosGh', 'pareceGh', 'repoDe', 'repoDeRuta']) assert.strictEqual(typeof gh[f], 'function', f);
  assert.deepStrictEqual(gh.programas, ['gh']);
  const cargador = fs.readFileSync(CARGADOR, 'utf8');
  assert.doesNotMatch(cargador, /'github'|'azure-devops'|gh-pr\.js/, 'el cargador no nombra ninguna plataforma');
  for (const f of USAN) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /gh-pr\.js'|'gh-pr\.js/, `${f} no carga el lector por su ruta`);
  const lista = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'neutrality-allowlist.json'), 'utf8'));
  assert.ok(!JSON.stringify(lista).includes('scripts/lib/gh-pr.js'), 'sale de la lista de neutralidad');
});

test('CommandReaders_SinLector: un programa sin lector es un error al pedirlo y null al buscarlo', () => {
  const C = require(CARGADOR);
  assert.throws(() => C.lectorDe('programa-que-no-existe'), /no hay lector de comandos para programa-que-no-existe/);
  assert.strictEqual(C.buscarLector('programa-que-no-existe'), null);
  // un árbol sin conectores (un hook copiado suelto): buscar calla, pedir falla
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'command-readers-'));
  dirs.push(d);
  assert.strictEqual(C.buscarLector('gh', { raiz: d }), null);
  assert.throws(() => C.lectorDe('gh', { raiz: d }), /no hay lector de comandos para gh/);
});

/** Un árbol de juguete con conectores cuyos lectores son el texto dado. */
function arbol(lectores) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'command-readers-'));
  dirs.push(d);
  for (const [conector, texto] of Object.entries(lectores)) {
    fs.mkdirSync(path.join(d, 'integrations', conector, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(d, 'integrations', conector, 'scripts', 'command-reader.js'), texto);
  }
  return d;
}

test('CommandReaders_OtroLectorRoto: no se elige a ciegas — el freno no lee y el aviso calla, sin caerse', () => {
  const C = require(CARGADOR);
  const d = arbol({ aaa: "throw new Error('roto');", github: "module.exports = { programas: ['gh'] };" });
  assert.strictEqual(C.buscarLector('gh', { raiz: d }), null, 'buscar no tira');
  assert.throws(() => C.lectorDe('gh', { raiz: d }), /no se pudo cargar[\s\S]*aaa/);
});

test('CommandReaders_DosLectoresParaElMismoPrograma: ninguno tapa al otro — el freno no lee y el aviso calla', () => {
  const C = require(CARGADOR);
  const d = arbol({ aaa: "module.exports = { programas: ['gh'], comandosGh: () => [] };", github: "module.exports = { programas: ['gh'] };" });
  assert.strictEqual(C.buscarLector('gh', { raiz: d }), null);
  assert.throws(() => C.lectorDe('gh', { raiz: d }), /más de un lector de comandos para gh[\s\S]*aaa[\s\S]*github/);
});

// 🔴 Falla con: un árbol sin el conector del lector de `az` (o con un lector roto) hace que los frenos de pedidos se
// caigan con salida 1, que deja pasar el comando, en vez de frenarlo con su motivo.
test('CommandReaders_SinElLectorDeAz_LosFrenosDePedidosFrenan: el freno dice que no pudo leer y frena; lo que no nombra a az ni a gh pasa', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'command-readers-sin-az-'));
  dirs.push(d);
  // el arnés sin el conector de Azure DevOps: el núcleo y el lector de gh
  for (const rel of ['scripts/lib', 'scripts/setup', 'integrations/github']) fs.cpSync(path.join(ROOT, rel), path.join(d, rel), { recursive: true });
  fs.mkdirSync(path.join(d, 'scripts', 'hooks'), { recursive: true });
  for (const h of ['pr-auto-complete-guard.js', 'pr-one-per-repo-guard.js', 'retro-pending.js']) fs.copyFileSync(path.join(ROOT, 'scripts', 'hooks', h), path.join(d, 'scripts', 'hooks', h));
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'command-readers-casa-'));
  dirs.push(casa);
  const correr = (hook, command, env = {}) => require('child_process').spawnSync(process.execPath, [path.join(d, 'scripts', 'hooks', hook)], {
    input: JSON.stringify({ session_id: 's1', cwd: casa, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: casa, ...env },
  });
  const pedido = 'az repos pr create --target-branch main --title x';
  // las formas del pase adversarial que pasaban el respaldo: az corrido por python, el nombre partido con comillas
  const formas = [pedido, 'python3 -m azure.cli repos pr create --target-branch main --title x', 'sudo /usr/bin/python3 -m azure.cli repos pr update --id 5 --status completed',
    'a""z repos pr create --target-branch main --title x'];
  for (const [hook, env] of [['pr-auto-complete-guard.js', {}], ['pr-one-per-repo-guard.js', { TYCON_PR_ONE_PER_REPO: '1' }]]) {
    for (const forma of formas) {
      const r = correr(hook, forma, env);
      assert.strictEqual(r.status, 2, `${hook} · ${forma}: ${r.status} ${r.stderr}`);
      assert.match(r.stderr, /no pude leer el comando/, hook);
    }
    assert.strictEqual(correr(hook, 'ls -la', env).status, 0, `${hook}: lo que no nombra a az ni a gh pasa`);
  }
  assert.strictEqual(correr('pr-auto-complete-guard.js', '$(which gh) pr merge 5 --squash').status, 2, 'un gh armado al correr');
  // retro-pending anota, no frena: sin el lector sigue andando
  const r = correr('retro-pending.js', pedido);
  assert.notStrictEqual(r.status, 1, `retro-pending se cayó: ${r.stderr}`);
});

// 🔴 Falla con: un archivo del arnés que todavía pide `scripts/lib/az-pr.js`, que ya no existe. Lo neutro está en
// scripts/lib/command-tokens.js y lo de az en su conector; un require viejo se cae al correr y el gancho calla.
test('CommandReaders_NadiePideElLectorViejo: ningún guion del arnés carga scripts/lib/az-pr.js', () => {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return; // una copia sin git: no hay lista de archivos que mirar
  const r = require('child_process').spawnSync('git', ['-C', ROOT, 'grep', '-n', '-E', "az-pr\\.js'\\)|lib/az-pr\\.js", '--', '*.js', '*.sh', ':!scripts/tests/command-readers.test.js'], { encoding: 'utf8' });
  // git grep sale 1 cuando no encuentra nada; 0 es que encontró, y otra cosa es que no pudo mirar
  assert.strictEqual(r.status, 1, r.stdout || r.stderr);
});
