'use strict';
/**
 * state-dir-parity.test.js — la carpeta del estado y la de los registros sueltos, dichas en shell y en JS, son la misma.
 *
 * La regla vive en dos lenguajes: `scripts/lib/state-dir.sh` (para los hooks en shell, que no pueden pagar el arranque
 * de Node en cada comando) y `tycon-home.js` + `scripts/lib/loose-logs.js` (para los guiones en JS). Dos copias se
 * separan solas si nadie las compara: esta prueba corre los mismos casos por los dos y exige el mismo resultado, y además
 * el resultado esperado (si los dos se equivocaran igual, la paridad sola no lo vería).
 *
 * Node corre en un proceso aparte con `HOME=<laboratorio>` y pide `stateDir()` SIN argumento: así `ownRootOf` lee
 * `TYCON_HOME` como en una máquina (con un `home` distinto de `os.homedir()` la ignora).
 * 🔴 Nada toca el HOME real.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
// la ruta le llega al shell por el ambiente, no por la línea de comando que arma
const SH = path.join(ROOT, 'scripts', 'lib', 'state-dir.sh');
const HOME_JS = path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js');
const LOOSE_JS = path.join(ROOT, 'scripts', 'lib', 'loose-logs.js');
const CLAUDE = '.' + 'claude';

function cleanEnv(home, tyconHome) {
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
  delete env.TYCON_HOME;
  if (tyconHome !== undefined) env.TYCON_HOME = tyconHome;
  return env;
}

/** Lo que dice el shell: [carpeta del estado, carpeta de los registros sueltos]. */
function fromShell(home, tyconHome, cwd) {
  const r = spawnSync('bash', ['-c', '. "$STATE_DIR_SH" && tycon_state_dir && printf "\\n" && tycon_logs_dir'],
    { env: { ...cleanEnv(home, tyconHome), STATE_DIR_SH: SH }, cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `state-dir.sh salió ${r.status}: ${r.stderr}`);
  return r.stdout.split('\n');
}

/** Lo que dice JS, en un Node aparte con el HOME del laboratorio. */
function fromNode(home, tyconHome, cwd) {
  const code = 'const TH = require(process.argv[1]); const L = require(process.argv[2]);'
    + 'process.stdout.write(TH.stateDir() + "\\n" + L.looseLogsDir());';
  const r = spawnSync(process.execPath, ['-e', code, HOME_JS, LOOSE_JS], { env: cleanEnv(home, tyconHome), cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `node salió ${r.status}: ${r.stderr}`);
  return r.stdout.split('\n');
}

function lab() {
  // realpath: en Mac el temporal vive detrás de un enlace, y las rutas se comparan como texto
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'state-dir-parity-')));
}

const CASES = [
  {
    name: '~/.tycon/state existe: la máquina vive en la casa propia',
    setup: (h) => { fs.mkdirSync(path.join(h, '.tycon', 'state'), { recursive: true }); },
    tyconHome: () => undefined,
    want: (h) => [path.join(h, '.tycon', 'state'), path.join(h, '.tycon', 'state')],
  },
  {
    name: 'sin ~/.tycon/state: el estado y los registros, donde siempre',
    setup: () => {},
    tyconHome: () => undefined,
    want: (h) => [path.join(h, CLAUDE, '.tycon-pipeline'), path.join(h, CLAUDE)],
  },
  {
    name: 'TYCON_HOME absoluta con su state',
    setup: (h) => { fs.mkdirSync(path.join(h, 'casa', 'state'), { recursive: true }); },
    tyconHome: (h) => path.join(h, 'casa'),
    want: (h) => [path.join(h, 'casa', 'state'), path.join(h, 'casa', 'state')],
  },
  {
    name: 'TYCON_HOME relativa no vale: cae a ~/.tycon, que no existe',
    setup: (h) => { fs.mkdirSync(path.join(h, 'casa', 'state'), { recursive: true }); },
    tyconHome: () => 'casa',
    want: (h) => [path.join(h, CLAUDE, '.tycon-pipeline'), path.join(h, CLAUDE)],
  },
  {
    name: 'TYCON_HOME relativa no vale: cae a ~/.tycon, que existe',
    setup: (h) => { fs.mkdirSync(path.join(h, 'casa', 'state'), { recursive: true }); fs.mkdirSync(path.join(h, '.tycon', 'state'), { recursive: true }); },
    tyconHome: () => 'casa',
    want: (h) => [path.join(h, '.tycon', 'state'), path.join(h, '.tycon', 'state')],
  },
  {
    name: 'TYCON_HOME con espacios adentro de la ruta',
    setup: (h) => { fs.mkdirSync(path.join(h, 'mi casa', 'state'), { recursive: true }); },
    tyconHome: (h) => path.join(h, 'mi casa'),
    want: (h) => [path.join(h, 'mi casa', 'state'), path.join(h, 'mi casa', 'state')],
  },
  {
    name: 'TYCON_HOME con blancos en los bordes: se recortan, como trim() en JS',
    setup: (h) => { fs.mkdirSync(path.join(h, 'casa', 'state'), { recursive: true }); },
    tyconHome: (h) => `  ${path.join(h, 'casa')}\t `,
    want: (h) => [path.join(h, 'casa', 'state'), path.join(h, 'casa', 'state')],
  },
  {
    name: 'TYCON_HOME absoluta SIN su state: no vive en la casa propia aunque ~/.tycon/state exista',
    setup: (h) => { fs.mkdirSync(path.join(h, 'casa'), { recursive: true }); fs.mkdirSync(path.join(h, '.tycon', 'state'), { recursive: true }); },
    tyconHome: (h) => path.join(h, 'casa'),
    want: (h) => [path.join(h, CLAUDE, '.tycon-pipeline'), path.join(h, CLAUDE)],
  },
  {
    name: 'TYCON_HOME vacía: como sin la variable',
    setup: (h) => { fs.mkdirSync(path.join(h, '.tycon', 'state'), { recursive: true }); },
    tyconHome: () => '   ',
    want: (h) => [path.join(h, '.tycon', 'state'), path.join(h, '.tycon', 'state')],
  },
];

test('T1 Paridad_ShellYTyconHome @story-8.150 @ac-1 — state-dir.sh y tycon-home.js/loose-logs.js dan las mismas carpetas', () => {
  for (const c of CASES) {
    const h = lab();
    try {
      c.setup(h);
      const th = c.tyconHome(h);
      const sh = fromShell(h, th, h);
      const js = fromNode(h, th, h);
      assert.deepStrictEqual(sh, js, `${c.name}: shell ${JSON.stringify(sh)} · JS ${JSON.stringify(js)}`);
      assert.deepStrictEqual(sh, c.want(h), `${c.name}: esperaba ${JSON.stringify(c.want(h))}, dieron ${JSON.stringify(sh)}`);
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  }
});

test('T1b StateDirSh_CargadoNoCambiaNada @story-8.150 @ac-1 — cargarlo con «.» no exporta ni cambia el PATH', () => {
  const h = lab();
  try {
    const r = spawnSync('bash', ['-c', 'before="$(env | sort)"; . "$STATE_DIR_SH"; after="$(env | sort)"; [ "$before" = "$after" ] && echo igual'],
      { env: { ...cleanEnv(h), STATE_DIR_SH: SH }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), 'igual', 'cargar state-dir.sh cambió el ambiente');
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});
