'use strict';
// El laboratorio del freno de publicación para las pruebas de fallas: una casa temporal, un clon falso del arnés con su
// remoto público, una copia del freno sin sus bibliotecas y una copia que se rompe a pedido. Nada lee la casa real.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const GUARD = path.join(ROOT, 'scripts', 'hooks', 'public-push-guard.js');
const LAUNCHER = path.join(ROOT, 'scripts', 'hooks', 'node-missing-launcher.sh');

function lab(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ppg-fallas-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const casa = path.join(dir, 'casa');
  const clon = path.join(dir, 'clon');
  fs.mkdirSync(casa, { recursive: true });
  fs.mkdirSync(path.join(clon, 'scripts'), { recursive: true });
  spawnSync('git', ['init', '-q', clon]);
  spawnSync('git', ['-C', clon, 'remote', 'add', 'origin', 'https://github.com/TYCON-SA/tycon-harness.git']);
  fs.writeFileSync(path.join(clon, 'scripts', 'install-tycon-hooks.sh'), '');
  // el freno solo, sin las bibliotecas que carga al revisar
  const sola = path.join(dir, 'sola', 'scripts', 'hooks', 'public-push-guard.js');
  fs.mkdirSync(path.dirname(sola), { recursive: true });
  fs.copyFileSync(GUARD, sola);
  // una copia con la revisión cambiada: `throw` (se escapa a la salida principal) o `hang` (no contesta). Falla antes de
  // cargar ninguna biblioteca, así que vive sola en la carpeta temporal
  const roto = (como) => {
    const f = path.join(dir, `rota-${como}`, 'scripts', 'hooks', 'public-push-guard.js');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const cuerpo = como === 'throw' ? "throw new Error('roto a propósito');" : 'for (;;) { /* colgado a propósito */ }';
    const src = fs.readFileSync(GUARD, 'utf8').replace('function hookMode(payloadText, env = process.env) {', (m) => `${m}\n  ${cuerpo}`);
    if (src === fs.readFileSync(GUARD, 'utf8')) throw new Error('no encontré hookMode para romperlo');
    fs.writeFileSync(f, src);
    return f;
  };
  const env = (extra = {}) => {
    const e = { ...process.env, HOME: casa, USERPROFILE: casa, ...extra };
    delete e.TYCON_HOME;
    return e;
  };
  const evento = (command, cwd = clon) => JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } });
  const correr = (input, { guion = GUARD, extra = {}, argv = null, timeout = 30000 } = {}) => {
    const r = spawnSync(argv ? argv[0] : process.execPath, argv ? argv.slice(1) : [guion], { input, encoding: 'utf8', env: env(extra), cwd: dir, timeout });
    return { code: r.status, err: r.stderr || '', out: r.stdout || '' };
  };
  // un PATH con bash y lo básico pero sin node: una carpeta con enlaces a cada programa que se pide
  const pathSin = (falta, programas = ['bash', 'cat', 'grep', 'printf', 'sed', 'git', 'node', 'head', 'tr']) => {
    const bin = path.join(dir, `bin-sin-${falta}`);
    fs.mkdirSync(bin, { recursive: true });
    for (const p of programas) {
      if (p === falta) continue;
      const w = spawnSync('/bin/sh', ['-c', `command -v ${p}`], { encoding: 'utf8' }).stdout.trim();
      if (w && !fs.existsSync(path.join(bin, p))) fs.symlinkSync(w, path.join(bin, p));
    }
    return bin;
  };
  return { dir, casa, clon, sola, roto, env, evento, correr, pathSin };
}

module.exports = { ROOT, GUARD, LAUNCHER, lab };
