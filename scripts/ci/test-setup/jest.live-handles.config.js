'use strict';
/**
 * La configuración de jest del formulario MÁS el detector de consultas y temporizadores vivos, sin editar la suya. Se corre
 * desde la carpeta del formulario: `npx jest --config <arnes-ci>/test-setup/jest.live-handles.config.js ...`.
 *
 * Carga la configuración del formulario con el `jest-config` del propio formulario, así acepta las mismas seis formas que
 * jest (`jest.config.js`, `.cjs`, `.mjs`, `.ts`, `.json` o la clave `jest` de package.json), y le cambia sólo dos cosas:
 *   · suma live-handles.js al FINAL de `setupFilesAfterEnv` (después del setup del formulario);
 *   · pone como entorno live-handles-env.js, que extiende el del formulario (el que declare, o el de jest por defecto).
 * `rootDir` queda el del formulario: su carpeta, o el que declare, resuelto desde ella.
 *
 * Es una función asíncrona porque una configuración `.mjs` sólo se puede importar.
 *
 * `--probe` (lo corre el paso de pruebas antes de jest): carga la configuración igual que jest y sale 0 si puede; si no,
 * anota «sin el detector» con el motivo en LIVE_HANDLES_OUT y sale 1, y el paso corre ese formulario sin `--config`, como
 * siempre. Nunca deja un formulario sin probar.
 */
const fs = require('fs');
const path = require('path');

const DETECTOR = path.join(__dirname, 'live-handles.js');
const ENVIRONMENT = path.join(__dirname, 'live-handles-env.js');

const resolveFrom = (id, dirs) => require.resolve(id, { paths: dirs });

/** El jest-config del formulario (el de su jest). */
function jestConfigOf(dir) {
  try {
    return require(resolveFrom('jest-config', [dir]));
  } catch (_) {
    const jest = path.dirname(resolveFrom('jest/package.json', [dir]));
    return require(resolveFrom('jest-config', [jest]));
  }
}

/** La ruta del entorno del formulario: `jsdom` → jest-environment-jsdom; una ruta, desde rootDir. */
function baseEnvironment(name, rootDir, dir) {
  const wanted = String(name || 'node').replace(/<rootDir>/g, rootDir);
  if (wanted.startsWith('.') || path.isAbsolute(wanted)) return resolveFrom(path.resolve(rootDir, wanted), [rootDir]);
  for (const id of [`jest-environment-${wanted}`, wanted]) {
    try { return resolveFrom(id, [rootDir, dir]); } catch (_) { /* el siguiente */ }
  }
  throw new Error(`no encuentro el entorno de jest «${wanted}» desde ${rootDir}`);
}

async function liveHandlesConfig(dir = process.cwd()) {
  const { readInitialOptions, normalize } = jestConfigOf(dir);
  const { config, configPath } = await readInitialOptions(undefined, { packageRootOrConfig: dir });
  const rootDir = path.resolve(dir, config.rootDir || '.');
  // El entorno, como lo resuelve jest: con el `preset` aplicado (un preset puede declarar jsdom).
  const { options } = await normalize({ ...config, rootDir }, {}, configPath);
  const base = options.testEnvironment && path.isAbsolute(options.testEnvironment)
    ? options.testEnvironment : baseEnvironment(options.testEnvironment || config.testEnvironment, rootDir, dir);
  require(base);
  process.env.LIVE_HANDLES_BASE_ENV = base;
  process.env.LIVE_HANDLES_FORM_DIR = dir;
  try {
    process.env.LIVE_HANDLES_TESTING_LIBRARY = resolveFrom('@testing-library/react', [rootDir, dir]);
  } catch (_) {
    delete process.env.LIVE_HANDLES_TESTING_LIBRARY;
  }
  return {
    ...config,
    rootDir,
    testEnvironment: ENVIRONMENT,
    setupFilesAfterEnv: [...(config.setupFilesAfterEnv || []), DETECTOR],
  };
}

module.exports = () => liveHandlesConfig();
module.exports.liveHandlesConfig = liveHandlesConfig;

if (require.main === module && process.argv.includes('--probe')) {
  liveHandlesConfig().then(() => process.exit(0), (e) => {
    const out = process.env.LIVE_HANDLES_OUT;
    const reason = String(e && e.message ? e.message : e).split('\n')[0];
    if (out) fs.appendFileSync(out, `${JSON.stringify({ event: 'no-detector', reason })}\n`);
    process.stderr.write(`sin el detector: ${reason}\n`);
    process.exit(1);
  });
}
