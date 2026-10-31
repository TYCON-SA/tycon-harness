#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * e2e-setup.js — prepara la prueba con navegador en el repo, la deshace, o deja anotado el «no» de la persona.
 *
 * Lo pide la oferta que el arnés le muestra a la persona (lib/browser-test.js) cuando una historia cambia una pantalla
 * y el repo no tiene cómo probar en un navegador. Preparar y anotar el «no» los aprueba la persona en la ventana de
 * permiso (o los corre ella con --terminal): ni el agente ni otra sesión deciden por ella.
 *
 * Uso:
 *   e2e-setup.js status  --repo <r>
 *   e2e-setup.js prepare --repo <r> --story <spec.md> [--approved-by "<el dev>"] [--url <dirección>] [--terminal]
 *   e2e-setup.js undo    --repo <r>
 *   e2e-setup.js defer   --repo <r> --story <spec.md> --no "<su respuesta>" [--approved-by "<el dev>"] [--terminal]
 *
 * Qué escribe `prepare`, en el repo: `@playwright/test` como dependencia de desarrollo en el package.json más cercano
 * a la pantalla (si no hay ninguno, crea uno en la raíz), Chromium en la carpeta de navegadores de Playwright (fuera
 * del repo), `playwright.config.ts`, `tests/e2e/<clave>.spec.ts` (abre la página y mira que cargue: los criterios los
 * escribe el paso de implementar), con una página estática `tests/e2e/servidor.mjs` para servirla, y el bloque
 * `e2e: { frontend_dir: … }` de `.tycon/advisors.yaml`. Lo anota en `.tycon/e2e-setup.json` con la huella de cada
 * archivo: `undo` borra sólo lo que nadie cambió, y nunca fuera del repo.
 *
 * `defer` pide además que la respuesta sea posterior a la oferta mostrada para esa historia. Escribe en la historia
 * `browser_test: deferred` y `browser_test_reason`, y deja la constancia en `gates.log` junto a la línea de la firma;
 * cada freno del cierre vuelve a buscar esa línea (la constancia sola no alcanza).
 *
 * Sale: 0 hecho · 1 no había nada que hacer (o falló un paso: lo dice) · 2 sin el ok de la persona, o uso.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const bt = require('./lib/browser-test.js');

const MANIFEST = path.join('.tycon', 'e2e-setup.json');
const PUERTO = 4173;
// Una carpeta que va dentro del comando del servidor de la configuración: sin espacios ni nada que la consola interprete.
const CARPETA_SEGURA = /^[\w./-]+$/;

const sha = (txt) => crypto.createHash('sha256').update(txt).digest('hex');
const rel = (repo, p) => path.relative(repo, p).split(path.sep).join('/') || '.';

/** ¿`p` queda dentro de `repo` (o es el repo)? */
function dentro(repo, p) {
  const r = path.relative(path.resolve(repo), path.resolve(repo, p));
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

/** Cómo se llama a npm y npx: en Windows son `.cmd` y van por la consola. */
function runner(platform = process.platform) {
  return { shell: platform === 'win32' };
}

/** La carpeta donde Playwright guarda sus navegadores. */
function browserDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'ms-playwright');
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  return path.join(home, '.cache', 'ms-playwright');
}

// Los argumentos de npm y npx son fijos (nunca vienen de la historia ni de la persona): por eso pueden ir por la consola en Windows.
function correr(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', ...runner() });
  if (r.error) throw new Error(`no pude correr ${cmd} ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} salió con ${r.status}`);
}

function opcion(argv, nombre) {
  const i = argv.indexOf(nombre);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function stateDir() {
  return require('./lib/story-gate-io.js').DEFAULT_STATE_DIR;
}

/** ¿`p` queda dentro de `repo` también siguiendo los enlaces? Para lo que existe (lo que no existe, por su carpeta). */
function dentroDeVerdad(repo, p) {
  let q = path.resolve(repo, p);
  while (!fs.existsSync(q) && path.dirname(q) !== q) q = path.dirname(q);
  try { return dentro(fs.realpathSync(repo), fs.realpathSync(q)); } catch (_e) { return false; }
}

/**
 * La aprobación de la persona en la ventana de permiso (o con --terminal, en su terminal). La cita y el reenvío ya no
 * firman. `{ codigo: 0, via }` o `{ codigo, motivo }`.
 */
function firmaDeLaPersona(argv, resumen, propia = PROPIA) {
  if (argv.includes('--relayed-by') || argv.includes('--ok')) {
    return { codigo: 2, motivo: 'la cita o el reenvío ya no firman: la persona lo aprueba en la ventana de permiso (este comando sin --ok ni --relayed-by) o en su terminal (--terminal)' };
  }
  const ow = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
  const r = ow.exigir({ firma: 'browser-test', argv: process.argv.slice(1), resumen,
    propia,
    anotar: (renglon) => bt.anotar(stateDir(), { ts: new Date().toISOString(), ...renglon }) });
  if (r.codigo !== 0) return { codigo: 2, motivo: r.motivo };
  // recién con la firma dada, el proceso pasa a trabajar sobre la sesión destino
  const f = ow.fijarDestino({ r, propia, necesitaMarcador: !!paraOtra, leerMarcador: leerMarcador });
  return f.codigo === 0 ? { ...r, constancia: f.constancia } : { codigo: 2, motivo: f.motivo };
}
const porDe = (firma) => (firma && firma.constancia && firma.constancia.por ? { por: firma.constancia.por } : {});
// null sin marcador; lanza si existe y no se puede leer
function leerMarcador(sid) {
  return require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'owner-window.js')).marcadorEn(path.join(stateDir(), 'active', `${sid}.json`));
}

// La firma pedida para otra sesión (`--for-session <D>`): sólo `prepare` y `defer`, y sólo si <D> tiene una ejecución
// abierta. Hasta la firma no se escribe nada; la firma la pide la sesión que corre el guion (PROPIA).
const PROPIA = require('./lib/session-id.js').sessionIdFileKey();
let paraOtra = null;   // { pedida, storyId } mientras el guion trabaja para otra sesión
function paraOtraSesion(cmd, argv) {
  const pedida = opcion(argv, '--for-session');
  if (!pedida || pedida === PROPIA) return null;
  // sin variable de sesión y sin terminal no hay quién pida la firma para otra sesión
  if (PROPIA === '_nosession' && !argv.includes('--terminal')) return 'sin variable de sesión, la firma para una sesión se da en la terminal de la persona (--terminal). No escribí nada.';
  // en la terminal del dueño, --for-session dice la sesión de su agente, que puede preparar fuera de una corrida: no
  // la pide otra sesión, así que no se exige la ejecución abierta
  if (PROPIA === '_nosession') return null;
  if (!['prepare', 'defer'].includes(cmd)) return `--for-session con otra sesión vale sólo para prepare y defer: ${cmd || '(sin subcomando)'} se corre desde la sesión destino. No escribí nada.`;
  if (!/^[\w-]+$/.test(pedida)) return 'la sesión de --for-session no se puede leer. No escribí nada.';
  if (pedida === '_nosession') return '«_nosession» es el nombre de «sin sesión», no una sesión: la firma se pide para la sesión destino por su id. No escribí nada.';
  let abierta;
  try { abierta = leerMarcador(pedida); } catch (e) { return `${e.message}. No escribí nada.`; }
  if (!abierta || !abierta.storyId) return `la sesión ${pedida} no tiene una ejecución abierta. No escribí nada.`;
  paraOtra = { pedida, storyId: String(abierta.storyId) };
  return null;
}
/** Para otra sesión, la historia es la de su corrida: el motivo si --story nombra otra, o null. */
function historiaAjena(id) {
  return paraOtra && paraOtra.storyId !== String(id) ? `la corrida de la sesión ${paraOtra.pedida} es de la historia ${paraOtra.storyId}, y --story nombra la ${id}. No escribí nada.` : null;
}

/** La historia, resuelta y dentro del repo; o el motivo. */
function historiaDelRepo(repo, story) {
  if (!story) return { motivo: 'falta --story <spec.md>' };
  const p = path.resolve(repo, story);
  if (!dentro(repo, p)) return { motivo: `la historia ${story} no está dentro del repo ${repo}` };
  if (!fs.existsSync(p)) return { motivo: `no encontré la historia ${p}` };
  if (!dentro(fs.realpathSync(repo), fs.realpathSync(p))) return { motivo: `la historia ${story} apunta fuera del repo` };
  return { path: p };
}

function rutasDeLaHistoria(content) {
  const fm = (String(content).match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
  const out = [];
  let enLista = false;
  for (const l of fm.split(/\r?\n/)) {
    if (/^files(_to_(create|modify))?\s*:/.test(l)) { enLista = true; continue; }
    if (/^\S/.test(l)) { enLista = false; continue; }
    const m = enLista && l.match(/^\s*-\s*["']?([^"'#\s]+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** La carpeta de la pantalla (la que tiene el index.html, subiendo desde cada archivo, sin salir del repo) o null. */
function carpetaDeLaPagina(repo, archivos) {
  for (const f of archivos) {
    if (!dentro(repo, f)) continue;
    let d = path.dirname(path.resolve(repo, f));
    while (dentro(repo, d)) {
      if (fs.existsSync(path.join(d, 'index.html'))) return d;
      if (path.resolve(d) === path.resolve(repo)) break;
      d = path.dirname(d);
    }
  }
  return null;
}

/** El package.json más cercano a la pantalla, sin salir del repo; si no hay, la raíz. */
function carpetaDelPaquete(repo, desde) {
  let d = path.resolve(desde || repo);
  while (dentro(repo, d)) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    if (path.resolve(d) === path.resolve(repo)) break;
    d = path.dirname(d);
  }
  return path.resolve(repo);
}

function textoConfig({ pagina, url }) {
  if (url) {
    return ["import { defineConfig } from '@playwright/test';", '',
      '// La app la levantás vos: la prueba entra en esta dirección.',
      `export default defineConfig({ testDir: './tests/e2e', use: { baseURL: ${JSON.stringify(url)} } });`, ''].join('\n');
  }
  return ["import { defineConfig } from '@playwright/test';", '',
    `// La página se sirve sola mientras corre la prueba (tests/e2e/servidor.mjs, puerto ${PUERTO}).`,
    'export default defineConfig({',
    "  testDir: './tests/e2e',",
    `  use: { baseURL: 'http://127.0.0.1:${PUERTO}' },`,
    `  webServer: { command: 'node tests/e2e/servidor.mjs ${pagina} ${PUERTO}', url: 'http://127.0.0.1:${PUERTO}', reuseExistingServer: true },`,
    '});', ''].join('\n');
}

const TEXTO_SERVIDOR = [
  "// Sirve una carpeta por HTTP para la prueba con navegador: node tests/e2e/servidor.mjs <carpeta> <puerto>",
  "import http from 'node:http';",
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  '',
  "const raiz = path.resolve(process.argv[2] || '.');",
  'const puerto = Number(process.argv[3] || 4173);',
  "const tipos = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };",
  'http.createServer((req, res) => {',
  '  let pedido;',
  "  try { pedido = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }",
  "  const archivo = path.resolve(raiz, '.' + (pedido.endsWith('/') ? `${pedido}index.html` : pedido));",
  '  const r = path.relative(raiz, archivo);',
  "  if (r.startsWith('..') || path.isAbsolute(r)) { res.writeHead(403); res.end(); return; }",
  '  let realRaiz, realArchivo;',
  '  try { realRaiz = fs.realpathSync(raiz); realArchivo = fs.realpathSync(archivo); } catch { res.writeHead(404); res.end(); return; }',
  '  const rr = path.relative(realRaiz, realArchivo);',
  "  if (rr.startsWith('..') || path.isAbsolute(rr)) { res.writeHead(403); res.end(); return; }",
  '  fs.readFile(realArchivo, (err, datos) => {',
  "    if (err) { res.writeHead(404); res.end('no está'); return; }",
  "    res.writeHead(200, { 'content-type': tipos[path.extname(archivo)] || 'application/octet-stream' });",
  '    res.end(datos);',
  '  });',
  "}).listen(puerto, '127.0.0.1');",
  '',
].join('\n');

function textoSpec(clave) {
  return ["import { test, expect } from '@playwright/test';", '',
    '// La primera prueba: abre la página y mira que cargue. Cada criterio de la historia suma la suya, con @ac-N.',
    `test('@story-${clave} la página abre', async ({ page }) => {`,
    "  await page.goto('/');",
    "  await expect(page.locator('body')).toBeVisible();",
    '});', ''].join('\n');
}

function cmdStatus(argv) {
  const repo = path.resolve(opcion(argv, '--repo') || process.cwd());
  process.stdout.write(`${JSON.stringify(bt.repoReady(repo))}\n`);
  return 0;
}

function cmdPrepare(argv) {
  const repo = path.resolve(opcion(argv, '--repo') || process.cwd());
  const url = opcion(argv, '--url');
  const h = historiaDelRepo(repo, opcion(argv, '--story'));
  if (h.motivo) { process.stderr.write(`e2e-setup.js prepare: ${h.motivo}\n`); return 2; }
  const content = fs.readFileSync(h.path, 'utf8');
  const id = bt.storyIdDe(content, h.path);
  const ajena = historiaAjena(id);
  if (ajena) { process.stderr.write(`e2e-setup.js prepare: ${ajena}\n`); return 2; }
  // todo lo que se comprueba va antes de la firma: después, una negativa pierde el «Sí» de la persona
  if (fs.existsSync(path.join(repo, MANIFEST))) { process.stderr.write('e2e-setup.js prepare: este repo ya tiene una preparación anotada (.tycon/e2e-setup.json)\n'); return 1; }
  if (bt.repoReady(repo).ready) { process.stdout.write('El repo ya tiene la prueba con navegador: no hace falta preparar nada.\n'); return 1; }
  const clave = bt.claveDe(h.path, content);
  if (!clave) { process.stderr.write(`e2e-setup.js prepare: la historia ${id} no tiene un número que sirva de nombre de archivo (letras, dígitos, punto, guion)\n`); return 2; }
  const pagina = carpetaDeLaPagina(repo, rutasDeLaHistoria(content));
  if (!pagina && !url) { process.stderr.write('e2e-setup.js prepare: no encontré la página (un index.html) de esta pantalla. Preguntale a la persona en qué dirección corre su app y pasala con --url.\n'); return 2; }
  if (url && !/^https?:\/\/[^\s'"`]+$/.test(url)) { process.stderr.write(`e2e-setup.js prepare: «${url}» no es una dirección http(s)\n`); return 2; }
  const pkg = carpetaDelPaquete(repo, pagina);
  if (!dentroDeVerdad(repo, pkg) || (pagina && !dentroDeVerdad(repo, pagina))) { process.stderr.write('e2e-setup.js prepare: la carpeta de la pantalla apunta fuera del repo (un enlace): no preparo nada\n'); return 2; }
  const paginaRel = pagina ? rel(pkg, pagina) : null;
  if (paginaRel && !CARPETA_SEGURA.test(paginaRel)) { process.stderr.write(`e2e-setup.js prepare: la carpeta de la página (${paginaRel}) tiene caracteres que no puedo poner en un comando\n`); return 2; }
  // el lector del bloque e2e: corta en el primer espacio: una carpeta con espacios quedaría mal leída
  if (!CARPETA_SEGURA.test(rel(repo, pkg))) { process.stderr.write(`e2e-setup.js prepare: la carpeta del package.json (${rel(repo, pkg)}) tiene caracteres que .tycon/advisors.yaml no puede leer\n`); return 2; }
  const ok = firmaDeLaPersona(argv, `preparar la prueba con navegador de la historia ${id} en ${repo}`);
  if (ok.codigo !== 0) { process.stderr.write(`e2e-setup.js prepare: no preparo nada — ${ok.motivo}\n`); return 2; }
  const advisors = path.join(repo, '.tycon', 'advisors.yaml');
  const yaTeniaE2e = fs.existsSync(advisors) && /^e2e\s*:/m.test(fs.readFileSync(advisors, 'utf8'));

  const anot = { version: 1, at: new Date().toISOString(), story: id, pkgDir: rel(repo, pkg), npmInit: false, installed: false, files: [], e2eBlock: null, advisorsCreated: false };
  const saltados = [];
  const guardar = () => { fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true }); fs.writeFileSync(path.join(repo, MANIFEST), `${JSON.stringify(anot, null, 2)}\n`); };
  const escribir = (archivo, texto) => {
    if (fs.existsSync(archivo)) { saltados.push(rel(repo, archivo)); return; }
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, texto);
    anot.files.push({ path: rel(repo, archivo), sha: sha(texto) });
    guardar();
  };
  try {
    guardar();
    if (!fs.existsSync(path.join(pkg, 'package.json'))) { correr('npm', ['init', '-y'], pkg); anot.npmInit = true; guardar(); }
    const p = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
    const tenia = !!((p.devDependencies && p.devDependencies['@playwright/test']) || (p.dependencies && p.dependencies['@playwright/test']));
    correr('npm', ['install', '--save-dev', '@playwright/test'], pkg);
    anot.installed = !tenia; guardar();
    correr('npx', ['playwright', 'install', 'chromium'], pkg);
    escribir(path.join(pkg, 'playwright.config.ts'), textoConfig({ pagina: paginaRel, url }));
    if (!url) escribir(path.join(pkg, 'tests', 'e2e', 'servidor.mjs'), TEXTO_SERVIDOR);
    escribir(path.join(pkg, 'tests', 'e2e', `${clave}.spec.ts`), textoSpec(clave));
    if (!yaTeniaE2e) {
      anot.advisorsCreated = !fs.existsSync(advisors);
      const bloque = `e2e:\n  frontend_dir: ${rel(repo, pkg)}\n`;
      fs.mkdirSync(path.dirname(advisors), { recursive: true });
      const antes = anot.advisorsCreated ? '' : fs.readFileSync(advisors, 'utf8');
      fs.writeFileSync(advisors, `${antes}${antes && !antes.endsWith('\n') ? '\n' : ''}${bloque}`);
      anot.e2eBlock = bloque; guardar();
    } else saltados.push('.tycon/advisors.yaml (ya tenía un bloque e2e:)');
  } catch (e) {
    process.stderr.write(`e2e-setup.js prepare: se cortó a mitad de camino — ${e.message}\n  Lo hecho quedó anotado en ${MANIFEST}: «e2e-setup.js undo» lo deshace.\n`);
    return 1;
  }
  const listo = bt.repoReady(repo);
  if (!listo.ready) {
    process.stderr.write(`e2e-setup.js prepare: terminé, pero el repo todavía no tiene la prueba con navegador (falta: ${listo.missing.join(', ')}).${saltados.length ? ` No toqué lo que ya existía: ${saltados.join(', ')}.` : ''}\n  Lo hecho quedó anotado en ${MANIFEST}: «e2e-setup.js undo» lo deshace.\n`);
    return 1;
  }
  bt.anotar(stateDir(), { ts: new Date().toISOString(), sessionId: process.env.CLAUDE_CODE_SESSION_ID || null, repoPath: repo, name: bt.PREPARED, status: 'ok', story: id, via: ok.via, ...porDe(ok) });
  process.stdout.write([
    'Listo: la prueba con navegador está preparada en el repo.',
    `  Playwright quedó en ${rel(repo, path.join(pkg, 'package.json'))} (herramienta de desarrollo) y Chromium en ${browserDir()}.`,
    `  Escribí: ${anot.files.map((f) => f.path).join(', ')}${anot.e2eBlock ? ', y el bloque e2e: de .tycon/advisors.yaml' : ''}.`,
    ...(saltados.length ? [`  No toqué lo que ya existía: ${saltados.join(', ')}.`] : []),
    `  La primera prueba (tests/e2e/${clave}.spec.ts) sólo abre la página: cada criterio de la historia suma la suya.`,
    '  Para volver atrás: «e2e-setup.js undo».', ''].join('\n'));
  return 0;
}

function cmdUndo(argv) {
  const repo = path.resolve(opcion(argv, '--repo') || process.cwd());
  const archivo = path.join(repo, MANIFEST);
  if (!fs.existsSync(archivo)) { process.stdout.write('No hay una preparación anotada en este repo (.tycon/e2e-setup.json): no toqué nada.\n'); return 1; }
  let anot;
  try { anot = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) { process.stderr.write(`e2e-setup.js undo: no pude leer ${MANIFEST} (${e.message}): no toqué nada.\n`); return 1; }
  // todo lo que nombra la anotación tiene que quedar dentro del repo: si no, no se toca nada
  const fuera = [anot.pkgDir || '.', ...(anot.files || []).map((f) => f && f.path)].filter((p) => typeof p !== 'string' || !dentro(repo, p) || !dentroDeVerdad(repo, p));
  if (fuera.length) { process.stderr.write(`e2e-setup.js undo: ${MANIFEST} nombra rutas fuera del repo (${fuera.join(', ')}): no toqué nada.\n`); return 1; }
  const pkg = path.resolve(repo, anot.pkgDir || '.');
  const quedan = [];
  try {
    if (anot.installed) correr('npm', ['uninstall', '--save-dev', '@playwright/test'], pkg);
  } catch (e) {
    process.stderr.write(`e2e-setup.js undo: no pude desinstalar Playwright — ${e.message}. No toqué lo demás.\n`);
    return 1;
  }
  for (const f of anot.files || []) {
    const p = path.resolve(repo, f.path);
    if (!fs.existsSync(p)) continue;
    if (sha(fs.readFileSync(p, 'utf8')) === f.sha) fs.rmSync(p);
    else quedan.push(f.path);
  }
  for (const d of [path.join(pkg, 'tests', 'e2e'), path.join(pkg, 'tests')]) {
    try { if (fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch (_e) { /* no estaba o tiene algo */ }
  }
  const advisors = path.join(repo, '.tycon', 'advisors.yaml');
  if (anot.e2eBlock && fs.existsSync(advisors)) {
    const txt = fs.readFileSync(advisors, 'utf8');
    if (txt.includes(anot.e2eBlock)) {
      const resto = txt.replace(anot.e2eBlock, '');
      if (anot.advisorsCreated && !resto.trim()) fs.rmSync(advisors);
      else fs.writeFileSync(advisors, resto);
    } else quedan.push('.tycon/advisors.yaml (el bloque e2e: cambió)');
  }
  fs.rmSync(archivo);
  try { if (fs.readdirSync(path.join(repo, '.tycon')).length === 0) fs.rmdirSync(path.join(repo, '.tycon')); } catch (_e) { /* tiene más cosas */ }
  const lineas = ['Listo: deshice la preparación de la prueba con navegador.'];
  if (anot.installed) lineas.push('  Desinstalé Playwright del repo.');
  if (quedan.length) lineas.push(`  Dejé lo que alguien cambió después: ${quedan.join(', ')}.`);
  if (anot.npmInit) lineas.push('  El package.json lo creé yo y lo dejé: puede tener otras cosas tuyas.');
  lineas.push(`  El navegador no lo borré (lo pueden usar otros proyectos): está en ${browserDir()}.`, '');
  process.stdout.write(lineas.join('\n'));
  return 0;
}

function cmdDefer(argv) {
  const repo = path.resolve(opcion(argv, '--repo') || process.cwd());
  const h = historiaDelRepo(repo, opcion(argv, '--story'));
  if (h.motivo) { process.stderr.write(`e2e-setup.js defer: ${h.motivo}\n`); return 2; }
  const txt = fs.readFileSync(h.path, 'utf8');
  const id = bt.storyIdDe(txt, h.path);
  const ajena = historiaAjena(id);
  if (ajena) { process.stderr.write(`e2e-setup.js defer: ${ajena}\n`); return 2; }
  if (bt.repoReady(repo).ready) { process.stderr.write('e2e-setup.js defer: el repo ya tiene prueba con navegador: se corre, no se deja pendiente.\n'); return 2; }
  const oferta = bt.lastOffer(stateDir(), id, repo);
  if (!oferta) { process.stderr.write(`e2e-setup.js defer: no hay constancia de que el arnés le haya mostrado la oferta a la persona para la historia ${id}: sin la oferta, el «no» no vale.\n`); return 2; }
  // la respuesta de la persona va a la historia; firmarla, la firma ella en la ventana de permiso, que muestra el comando
  const cita = bt.citaEnUnRenglon(opcion(argv, '--no'));
  // tiene que ser un no: el ok de otra cosa («aprobado el plan») no declara que la prueba queda pendiente
  if (!/\bno\b/i.test(cita)) { process.stderr.write(`e2e-setup.js defer: «${cita}» no dice que no: poné en --no la respuesta de la persona a la oferta.\n`); return 2; }
  // en la terminal del dueño no hay variable de sesión: el «no» contesta la oferta, y la firma es para su sesión
  const propia = PROPIA === '_nosession' && oferta.sessionId ? oferta.sessionId : PROPIA;
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) { process.stderr.write('e2e-setup.js defer: la historia no tiene frontmatter\n'); return 2; }
  const ok = firmaDeLaPersona(argv, `dejar pendiente la prueba con navegador de la historia ${id}: «${cita}»`, propia);
  if (ok.codigo !== 0) { process.stderr.write(`e2e-setup.js defer: no anoto nada — ${ok.motivo}\n`); return 2; }
  const fecha = new Date().toISOString().slice(0, 10);
  const motivo = `${fecha} — la persona: «${cita}»`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const fm = m[1].split(/\r?\n/).filter((l) => !/^browser_test(_reason)?\s*:/.test(l));
  fm.push('browser_test: deferred', `browser_test_reason: "${motivo}"`);
  // la constancia primero, después de la línea de la firma que dejó la ventana (o la terminal), para la sesión firmada
  bt.anotar(stateDir(), {
    ts: new Date().toISOString(), sessionId: ok.destino || propia, repoPath: repo, storyPath: fs.realpathSync(h.path),
    name: bt.DEFERRED, status: 'ok', story: id, cita, quoteSha: bt.huella(cita), offerTs: oferta.ts,
    approvedBy: opcion(argv, '--approved-by') || process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'persona', via: ok.via, ...porDe(ok),
  });
  // con función: una respuesta con `$&` o `$$` no se interpreta como patrón de reemplazo
  fs.writeFileSync(h.path, txt.replace(m[0], () => `---\n${fm.join('\n')}\n---`));
  const d = bt.debtDeclared({ stateDir: stateDir(), storyPath: h.path });
  if (!d.declared) { process.stderr.write(`e2e-setup.js defer: anoté el «no» pero no lo puedo comprobar de vuelta — ${d.motivo}\n`); return 1; }
  process.stdout.write(`${bt.debtLine(d)}\n`);
  return 0;
}

function main(argv) {
  const cmd = argv[0];
  const otra = paraOtraSesion(cmd, argv);
  if (otra) { process.stderr.write(`e2e-setup.js: ${otra}\n`); return 2; }
  if (cmd === 'status') return cmdStatus(argv);
  if (cmd === 'prepare') return cmdPrepare(argv);
  if (cmd === 'undo') return cmdUndo(argv);
  if (cmd === 'defer') return cmdDefer(argv);
  process.stderr.write('uso: e2e-setup.js status|prepare|undo|defer --repo <r> … (ver la cabecera)\n');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { runner, browserDir, dentro, main };
