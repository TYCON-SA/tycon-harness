#!/usr/bin/env node
/**
 * produccion-notice.js — al abrir la sesión: regenera el índice de servidores y, SÓLO en las
 * máquinas autorizadas a tocar producción, grita si el freno no está, quedó viejo o fue alterado.
 *
 * POR QUÉ SÓLO EN ESAS MÁQUINAS: el resto del equipo no instala nada, así que un
 * aviso ahí sería ruido en cada arranque — y un aviso que suena sin motivo es el que se aprende a
 * ignorar. «Autorizada» = ya instaló el freno alguna vez, o tiene una entrada `tycon-prod-*` en el
 * llavero propio (se pregunta si EXISTE, sin leer la clave ni abrir cuadro). Una máquina sin llavero que sólo tiene
 * clonado un repo que declara producción recibe el aviso de que falta el freno UNA vez, y queda sellado.
 *
 * CONTRA QUÉ COMPARA: contra lo PUBLICADO (`origin/main` del clon del arnés), no contra el disco —
 * un archivo retocado en el clon diría «actualizalo» y el instalador instalaría lo retocado.
 * Una versión instalada que coincide con una publicada ANTERIOR
 * es «quedó vieja» (rojo); una que no coincide con ninguna publicada es «alterada» (rojo). Y reverifica
 * las huellas de `/opt/tycon/huellas.json` contra los archivos instalados (AC 29). Compara el freno, la puerta, el
 * lanzador, la configuración administrada y las bibliotecas que el freno requiere
 * (`BIBLIOTECAS_DEL_FRENO`) — contra la COPIA PROPIA del freno (scripts/production/guard-libs/), no
 * contra las bibliotecas compartidas: un cambio en el resto del arnés no pide reinstalar.
 *
 * EN UNA VERSIÓN BAJADA: el arnés que corre no es un clon (`~/.tycon/harness`, sin git) y el freno se
 * instala desde ESA carpeta, que no trae los mismos bytes que el clon interno. La referencia pasa a ser la versión que
 * corre —su manifiesto, `.tycon-release.json`— y, para saber si lo instalado es lo que dejó el instalador, la constancia
 * que éste escribe como root (`/opt/tycon/production/installed-files.json`). Igual a la versión que corre: al día.
 * Distinto, pero igual a la constancia: quedó viejo. Distinto de las dos: alguien lo cambió.
 *
 * TAMBIÉN LEE `hook-errors.log`: el freno anota ahí cuando no pudo decidir. Un registro que nadie
 * mira no sirve de nada.
 *
 * EL RENOMBRE A INGLÉS: la carpeta del freno pasó de `scripts/produccion/` a `scripts/production/`
 * y varios archivos cambiaron de nombre. Una copia instalada ANTES del renombre coincide con una versión publicada de la
 * ruta VIEJA: por eso la historia se busca en la ruta nueva y en la vieja (el mapa, scripts/lib/renames.json), y esa
 * copia es «quedó viejo: reinstalalo», nunca «alguien lo cambió».
 *
 * Nunca bloquea nada: imprime y sale 0. Off: TYCON_PRODUCTION_NOTICE=0
 * A mano:  node produccion-notice.js --report        (dice todo, aunque esté bien)
 *          node produccion-notice.js --reindex --json (regenera el índice e imprime el resumen)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// los nombres viejos de las variables y de las rutas: sin la biblioteca, sólo los nuevos
const legacy = (() => { try { return require(path.join(__dirname, '..', 'lib', 'legacy-names.js')); } catch { return null; } })();
const variable = (nombre) => (legacy ? legacy.readEnv(nombre, { where: 'scripts/hooks/produccion-notice.js' }) : process.env[nombre]);

const ARGS = process.argv.slice(2);
const REPORTE = ARGS.includes('--report');
const COMO_MODULO = require.main !== module;
if (!COMO_MODULO && variable('TYCON_PRODUCTION_NOTICE') === '0' && !REPORTE && !ARGS.includes('--reindex')) process.exit(0);

const HOME = process.env.HOME || os.homedir();
// La raíz alternativa se honra sólo si /opt/tycon no existe de verdad: es para las pruebas, no un
// interruptor (misma regla que la puerta y el freno).
const RAIZ = (!fs.existsSync('/opt/tycon') && process.env.TYCON_PROD_ROOT) ? process.env.TYCON_PROD_ROOT : '';
// 🔴 `RAIZ || '/'`: con la raíz vacía —o sea, en TODA máquina de verdad— `path.join('', 'opt', 'tycon')`
// da `opt/tycon`, una ruta RELATIVA al directorio donde corra el aviso. Resultado: el arranque gritaría
// «el freno NO está instalado» justo en las máquinas donde SÍ lo está, todos los días. No se vería en el
// banco porque ahí la raíz siempre viene puesta: la costura de prueba taparía el defecto.
const OPT = path.join(RAIZ || '/', 'opt', 'tycon');
const MANAGED_D = path.join(RAIZ || '/', 'Library', 'Application Support', 'ClaudeCode', 'managed-settings.d');
// el archivo administrado con su nombre de antes del renombre, si la máquina todavía no reinstaló
const MANAGED = [path.join(MANAGED_D, 'tycon-production.json'), path.join(MANAGED_D, 'tycon-produccion.json')]
  .find((f) => fs.existsSync(f)) || path.join(MANAGED_D, 'tycon-production.json');
const ARNES = process.env.TYCON_GUIDES_DIR || path.resolve(__dirname, '..', '..');   // este hook vive en el arnés: su ubicación
const SECURITY = path.join(RAIZ, 'usr', 'bin', 'security');
const LLAVERO_PROPIO = path.join(HOME, 'Library', 'Keychains', 'tycon-prod.keychain-db');
const INSTALADOR = path.join(ARNES, 'scripts', 'production', 'install-guard.command');

const avisos = [];
const lineas = [];
const sha256 = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
const existe = (f) => { try { fs.statSync(f); return true; } catch { return false; } };

// 🔴 El instalador se ABRE solo, en vez de ser un comando que cada dev corre en su máquina. El arnés se instala a sí mismo en cada arranque; el
// freno tiene que entrar por el mismo camino. Lo único que no puede hacer es escribir la contraseña
// del Mac: por eso abre la ventana del instalador, que la pide, en vez de instalar en silencio. Una
// vez por día como mucho (un aviso que salta en cada sesión se cierra sin leer). Bajo la raíz de
// prueba no abre ninguna ventana, pero deja la constancia igual, que es lo que el banco mira.
// Off: TYCON_PRODUCTION_AUTOINSTALL=0.
const SELLO_INSTALADOR = path.join(stateDirOf(HOME), 'instalar-freno-abierto');
// el aviso de una sola vez de la máquina sin el llavero de producción (ver `soloPorRepo` en main)
const SELLO_SIN_LLAVERO = path.join(stateDirOf(HOME), 'aviso-freno-sin-llavero-dado');
function abrirInstalador() {
  if (variable('TYCON_PRODUCTION_AUTOINSTALL') === '0') return false;
  if (process.platform !== 'darwin') return false;
  const hoy = new Date().toISOString().slice(0, 10);
  try { if (fs.readFileSync(SELLO_INSTALADOR, 'utf8').trim() === hoy) return false; } catch { /* nunca se abrió */ }
  try { fs.mkdirSync(path.dirname(SELLO_INSTALADOR), { recursive: true }); fs.writeFileSync(SELLO_INSTALADOR, hoy + '\n'); } catch { return false; }
  if (!RAIZ && existe(INSTALADOR)) spawnSync('open', [INSTALADOR], { stdio: 'ignore', timeout: 5000 });
  return true;
}
// Contra qué se compara lo instalado: en un clon, el propio árbol; en una versión bajada, el
// clon que la máquina declara mantener (`paths.maintained`), o ninguno — y entonces no se corre git sobre ~/.tycon ni se
// avisa «no pude leer lo publicado»: la comparación calla.
// 🔴 Esto vale cuando el arnés que corre es un CLON. Si es una versión bajada, lo instalado se juzga contra ella y no
// contra este clon (más abajo, `BAJADA`): el freno se instala desde la versión bajada, no desde el clon que se mantiene.
const PUBLICADO = (() => {
  try { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return fs.existsSync(lib) ? require(lib).maintainedDir(HOME, ARNES) : ARNES; } catch (_) { return ARNES; }
})();
const git = (args) => (PUBLICADO ? spawnSync('git', ['-C', PUBLICADO, ...args], { encoding: 'utf8', timeout: 5000 }) : { status: 1, stdout: '', stderr: 'sin clon que mantener' });

/** Hash de blob de git de un archivo (para compararlo con lo publicado sin depender del disco del clon). */
function blobDe(archivo) {
  const r = spawnSync('git', ['hash-object', archivo], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Las rutas que tuvo `rutaEnRepo` antes del renombre a inglés, según el mapa: la de su entrada `file` y, si la carpeta
 * se renombró, la misma ruta en la carpeta vieja. Sin mapa (la copia pública), ninguna.
 */
function rutasViejas(rutaEnRepo) {
  let entradas = [];
  try { entradas = legacy ? legacy.usableEntries(legacy.loadMap()) : []; } catch { entradas = []; }
  const viejas = new Set();
  for (const e of entradas) {
    if (e.repo === 'agent-skills') continue;
    if (e.kind === 'file' && e.new === rutaEnRepo) viejas.add(e.old);
    if (e.kind === 'folder' && rutaEnRepo.startsWith(`${e.new}/`)) viejas.add(`${e.old}/${rutaEnRepo.slice(e.new.length + 1)}`);
  }
  viejas.delete(rutaEnRepo);
  return [...viejas];
}

/**
 * @param {string} [antes] de dónde lo copiaba el instalador antes de la copia propia (la biblioteca compartida): un freno
 *   instalado entonces coincide con una versión publicada de ESA ruta, y es «quedó viejo», no «alguien lo cambió»
 * @returns {'al-dia'|'vieja'|'alterada'|'sin-publicado'} estado de lo instalado contra origin/main
 */
function estadoContraPublicado(instalado, rutaEnRepo, antes) {
  const blob = blobDe(instalado);
  if (!blob) return 'alterada';
  const actual = git(['rev-parse', `origin/main:${rutaEnRepo}`]);
  if (actual.status !== 0) return 'sin-publicado';
  if (actual.stdout.trim() === blob) return 'al-dia';
  // 🔴 En la historia de la ruta NUEVA y de la VIEJA: `git log -- <ruta nueva>` no sigue el renombre,
  // así que una copia instalada antes de él no coincidiría con nada y se leería «alguien lo cambió». Lo mismo con la copia
  // propia: una biblioteca instalada antes de ella sale de la historia de la compartida.
  const rutas = [rutaEnRepo, ...rutasViejas(rutaEnRepo)];
  if (antes) rutas.push(antes, ...rutasViejas(antes));
  for (const ruta of rutas) {
    const hist = git(['log', '--format=%H', '-n', '100', 'origin/main', '--', ruta]);
    if (hist.status !== 0) continue;
    for (const commit of hist.stdout.split('\n').filter(Boolean)) {
      const b = git(['rev-parse', `${commit}:${ruta}`]);
      if (b.status === 0 && b.stdout.trim() === blob) return 'vieja';
    }
  }
  return 'alterada';
}

// ── la versión BAJADA ───────────────────────────────────────────────────────────────────────────────────
// 🔴 Comparar sólo contra `origin/main` del clon que la máquina mantiene (`paths.maintained`) diría en cada arranque «NO
// coincide con ninguna versión publicada… alguien lo cambió» a una máquina con el freno instalado desde la versión
// bajada: esa copia no trae los mismos bytes. Y sin clon declarado, la comparación callaría entera.
// Una versión bajada se reconoce igual que en el instalador: trae su manifiesto y no es un clon. Se mira el árbol de
// TYCON_GUIDES_DIR y el de este archivo (el arnés que corre), sin cargar nada: este aviso viaja suelto.
const MANIFIESTO_BAJADA = '.tycon-release.json';
const esVersionBajada = (dir) => !!dir && existe(path.join(dir, MANIFIESTO_BAJADA)) && !existe(path.join(dir, '.git'));
const BAJADA = [ARNES, path.resolve(__dirname, '..', '..')].find(esVersionBajada) || null;
// lo que el instalador dejó, escrito por root (install-guard.sh): la misma forma que el manifiesto, `files: [{ path, blob }]`
const CONSTANCIA_INSTALADO = path.join(OPT, 'production', 'installed-files.json');

/** El blob de git de un archivo, calculado acá: una máquina con una versión bajada puede no tener git. */
function blobSinGit(archivo) {
  try { const d = fs.readFileSync(archivo); return crypto.createHash('sha1').update(`blob ${d.length}\0`).update(d).digest('hex'); } catch { return null; }
}

/** `ruta → blob` de un manifiesto o de la constancia del instalador; null si no se lee o no trae `files`. */
function blobsDe(archivo) {
  try {
    const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    if (!j || !Array.isArray(j.files)) return null;
    const m = new Map();
    for (const f of j.files) if (f && typeof f.path === 'string' && typeof f.blob === 'string') m.set(f.path, f.blob);
    return m;
  } catch { return null; }
}

/**
 * El estado de lo instalado en una versión bajada, que no tiene historia de git.
 * @param {Map<string,string>} corre lo que publica la versión que corre
 * @param {Map<string,string>|null} dejado lo que dejó el instalador; null = un freno instalado antes de la constancia
 * @param {string} [antes] la ruta de la biblioteca compartida de la que sale antes de la copia propia
 * @returns {'al-dia'|'vieja'|'alterada'|'sin-publicado'}
 */
function estadoContraVersionBajada(instalado, rutaEnRepo, corre, dejado, antes) {
  const blob = blobSinGit(instalado);
  if (!blob) return 'alterada';
  const publicado = corre.get(rutaEnRepo);
  if (!publicado) return 'sin-publicado';
  if (publicado === blob) return 'al-dia';
  // Sin constancia no hay con qué decir «alguien lo cambió»: es un freno instalado antes de ella (o desde el clon) y lo que le toca es reinstalar, que la deja escrita. La puerta y el freno los cubren igual sus huellas.
  if (!dejado) return 'vieja';
  // una constancia de antes de la copia propia anota la biblioteca con la ruta de la compartida, de donde se copió
  const anotado = dejado.has(rutaEnRepo) ? dejado.get(rutaEnRepo) : (antes ? dejado.get(antes) : undefined);
  return anotado === blob ? 'vieja' : 'alterada';
}

// El texto exacto: lo busca una prueba y lo lee la persona en cada arranque.
const AVISO_VIEJO = 'el freno quedó viejo: reinstalalo';

/**
 * Las bibliotecas que el freno INSTALADO requiere de verdad: dónde quedan en /opt/tycon y de qué
 * archivo del arnés salen. Un arnés que cambia sólo una de ellas (el lector de nombres, por ejemplo) deja al freno
 * instalado leyendo con la versión vieja, igual que si cambiara el hook: eso también es «quedó viejo».
 * No son todas las de `ARCHIVOS` del instalador, sólo las que el freno carga: el costo es
 * que un cambio en cualquiera de éstas pide reinstalar con sudo en cada máquina autorizada. La lista no se escribe de
 * memoria: `install-guard.test.sh` (T31c) corre el freno instalado con un trazador y exige que esta lista sea
 * exactamente lo que cargó. La de las constancias se compara por su nombre de hoy: el freno
 * la carga primero por ése y sólo si falta por el anterior (el instalador la deja con los dos).
 */
// 🔴 LA COPIA PROPIA: ese costo se pagaría casi en cada versión, porque las bibliotecas
// compartidas cambian todo el tiempo por motivos que no son del freno. Por eso `repo` es la copia del freno
// (scripts/production/guard-libs/), que cambia sólo cuando alguien lo decide (guard-libs-check.js); `antes` es la
// compartida de la que se copiaba hasta entonces: un freno instalado así se reconoce como «quedó viejo», no «alterado».
const COPIA_PROPIA = 'scripts/production/guard-libs/';
const BIBLIOTECAS_DEL_FRENO = [
  { opt: 'lib/shell-parse.js', repo: `${COPIA_PROPIA}lib/shell-parse.js`, antes: 'scripts/lib/shell-parse.js' },
  { opt: 'production/production-index.js', repo: 'scripts/production/production-index.js' },
  { opt: 'lib/guard-record.js', repo: `${COPIA_PROPIA}lib/guard-record.js`, antes: 'scripts/lib/guard-record.js' },
  { opt: 'lib/repos-root.js', repo: `${COPIA_PROPIA}lib/repos-root.js`, antes: 'scripts/lib/repos-root.js' },
  { opt: 'lib/tycon-config.js', repo: `${COPIA_PROPIA}lib/tycon-config.js`, antes: 'scripts/lib/tycon-config.js' },
  { opt: 'lib/legacy-names.js', repo: `${COPIA_PROPIA}lib/legacy-names.js`, antes: 'scripts/lib/legacy-names.js' },
  { opt: 'lib/skills-dir.js', repo: `${COPIA_PROPIA}lib/skills-dir.js`, antes: 'scripts/lib/skills-dir.js' },
  // dónde vive cada cosa en la máquina: tycon-config.js y skills-dir.js la cargan si está
  { opt: 'setup/harness/tycon-home.js', repo: `${COPIA_PROPIA}setup/harness/tycon-home.js`, antes: 'scripts/setup/harness/tycon-home.js' },
];
// La única vez que pide reinstalar por la copia propia: un freno instalado antes de ella. Lo dice la constancia del
// instalador (sus rutas son las de la copia); sin constancia, o ilegible, es de antes.
const TEXTO_COPIA_PROPIA = '   Esta vez es por un cambio de fondo: desde esta versión el freno lleva su propia copia de las bibliotecas que usa. Después de reinstalar, sólo te va a pedir reinstalar cuando cambie el freno, no cada vez que cambia el resto del arnés.';
const instaladoConCopiaPropia = (dejado) => !!dejado && [...dejado.keys()].some((p) => p.startsWith(COPIA_PROPIA));

function main() {
  // ── 1. el índice (AC 2) ──────────────────────────────────────────────────────────────────────
  let indice = null;
  try {
    const mod = require(path.join(__dirname, '..', 'production', 'production-index.js'));
    indice = mod.guardar(mod.construir({ home: HOME }), HOME);
    // La configuración del arnés rota viaja en el índice y es un AVISO de cada arranque, tenga o
    // no freno esta máquina: sin esto, en una máquina autorizada sin otros avisos, el error queda mudo.
    for (const e of indice.errores || []) if (/configuración del arnés ROTA/.test(e.motivo)) avisos.push(`⚠ ${e.motivo}`);
  } catch (e) {
    avisos.push(`🟠 no pude regenerar el índice de servidores de producción: ${e.message}`);
  }
  if (ARGS.includes('--reindex')) {
    const r = indice
      ? { raiz: indice.raiz, fuente: indice.fuente, catalogos: indice.catalogos.length, produccion: Object.values(indice.hosts).filter((h) => h.ambiente === 'produccion').length, memoria_alterada: indice.memoria_alterada, errores: indice.errores.length }
      : { error: 'no se pudo regenerar el índice' };
    console.log(ARGS.includes('--json') ? JSON.stringify(r, null, 2) : r);
    process.exit(0);
  }

  // ── 2. ¿es una máquina autorizada? ───────────────────────────────────────────────────────────
  const instaladoAlgunaVez = existe(path.join(OPT, 'huellas.json')) || existe(path.join(OPT, 'bin', 'tycon-prod-sql'));
  const llaveros = indice ? [...new Set(Object.values(indice.hosts || {}).map((h) => h.llavero).filter(Boolean))] : [];
  let tieneClave = false; let llaveroIlegible = false;
  if (existe(LLAVERO_PROPIO) || RAIZ) {
    for (const ll of llaveros) {
      // Sin -w y sin -g: se pregunta si la entrada EXISTE; no se lee el secreto y no abre cuadro.
      const r = spawnSync(existe(SECURITY) ? SECURITY : '/usr/bin/security', ['find-generic-password', '-s', ll, LLAVERO_PROPIO], { encoding: 'utf8', timeout: 4000 });
      if (r.status === 0) { tieneClave = true; break; }
      // 44 = no está. Cualquier otra cosa es «no pude preguntar», que NO es «no autorizada».
      if (r.status !== 44) llaveroIlegible = true;
    }
  }
  // 🔴 Tener el llavero propio CREADO ya es ser una máquina de producción: se crea al cargar la
  // primera clave y no lo crea nada más. Si hiciera falta poder CONSULTARLO, un llavero
  // bloqueado (o un `security` que no contesta) dejaría a una máquina autorizada sin ninguno de estos
  // avisos —justo la que más los necesita—.
  // 🔴 Y tener en la máquina un repo que DECLARA un servidor de producción también alcanza: sumar a
  // alguien al freno con un instructivo deja sin freno y sin aviso, en silencio, a quien no lo sigue.
  // El arnés se lo dice solo: si trabajás en un proyecto con producción declarada,
  // el aviso de arranque te da el comando. Lo único que no se puede automatizar es la contraseña del
  // Mac que pide instalar (escribe en /opt y en /Library).
  const trabajaConProduccion = !!(indice && Object.values(indice.hosts || {}).some((h) => h.ambiente === 'produccion'));
  // 🔴 Sin el llavero de producción, el repo que declara producción es lo único que la hace «autorizada»: es la máquina
  // de cualquiera que tenga el proyecto clonado. Ahí el aviso sale UNA vez, con cómo instalar, y queda sellado; un aviso
  // que sale en cada arranque a quien no toca producción se aprende a ignorar. Con el llavero, o sin poder consultarlo
  // («no pude preguntar» no es «no tiene»), sale en cada arranque.
  const soloPorRepo = trabajaConProduccion && !instaladoAlgunaVez && !tieneClave && !existe(LLAVERO_PROPIO) && !llaveroIlegible;
  const sellado = soloPorRepo && existe(SELLO_SIN_LLAVERO);
  const autorizada = !sellado && (instaladoAlgunaVez || tieneClave || existe(LLAVERO_PROPIO) || trabajaConProduccion);
  if (!autorizada) {
    // La configuración del arnés rota se DICE aunque esta máquina no tenga producción: el resto de
    // los avisos del freno no aplican acá, éste sí — es un archivo de la máquina, no del freno.
    for (const a of avisos.filter((a) => /configuración del arnés/.test(a))) console.log(a);
    if (llaveroIlegible) console.log('🟠 freno de producción: no pude consultar el llavero propio para saber si esta máquina tiene la clave de producción.');
    else if (REPORTE) console.log(sellado
      ? 'freno de producción: esta máquina no tiene el llavero de producción y el aviso de que falta el freno ya salió una vez.'
      : 'freno de producción: esta máquina no está autorizada (sin freno instalado ni clave de producción): nada que avisar.');
    process.exit(0);                     // el resto del equipo no recibe nada (AC 25)
  }
  if (llaveroIlegible) avisos.push('🟠 freno de producción: no pude consultar el llavero propio para saber si esta máquina tiene la clave de producción.');

  // ── 3. lo que tiene que estar, contra lo PUBLICADO ───────────────────────────────────────────
  const piezas = [
    { instalado: path.join(OPT, 'hooks', 'prod-access-guard.js'), repo: 'scripts/hooks/prod-access-guard.js', nombre: 'el freno' },
    { instalado: path.join(OPT, 'bin', 'tycon-prod-sql'), repo: 'scripts/production/tycon-prod-sql', nombre: 'la puerta' },
    { instalado: path.join(OPT, 'node-shim.sh'), repo: 'scripts/production/node-shim.sh', nombre: 'el lanzador del freno' },
    { instalado: MANAGED, repo: 'scripts/production/managed-settings.tycon-production.json.template', nombre: 'la configuración administrada' },
  ];
  const faltan = piezas.filter((p) => !existe(p.instalado));
  // las bibliotecas del freno: se comparan contra lo publicado como las piezas. Una que falta se dice
  // sólo si nada más pide reinstalar: en una copia de antes del renombre faltan por estar con su nombre viejo, y eso ya
  // lo dice «quedó viejo».
  const bibliotecas = BIBLIOTECAS_DEL_FRENO.map((b) => ({ instalado: path.join(OPT, b.opt), repo: b.repo, antes: b.antes, nombre: `la biblioteca ${path.basename(b.opt)}` }));
  const bibliotecasFaltan = bibliotecas.filter((b) => !existe(b.instalado));
  const aMediasPorBibliotecas = () => avisos.push(`🔴 el freno está instalado A MEDIAS: falta ${bibliotecasFaltan.map((f) => f.nombre).join(', ')}. Reinstalalo: open ${INSTALADOR}`);
  let administradaVieja = false;   // la administrada es de antes del renombre: «quedó viejo» ya lo dice todo
  if (faltan.length === piezas.length) {
    avisos.push('🔴 el FRENO DE PRODUCCIÓN no está instalado en esta máquina, y esta máquina tiene acceso a producción.');
    avisos.push(`   Instalalo (pide tu contraseña del Mac, una vez): open ${INSTALADOR}`);
  } else if (faltan.length) {
    avisos.push(`🔴 el freno está instalado A MEDIAS: falta ${faltan.map((f) => f.nombre).join(', ')}. Reinstalalo: open ${INSTALADOR}`);
  } else {
    // contra qué se juzga cada pieza: la versión bajada que corre (sin git), o lo publicado del clon
    let estadoDe = null;
    let textoAlterada = 'el freno instalado NO coincide con ninguna versión publicada';
    let causaAlterada = 'alguien lo cambió, o se instaló desde un disco retocado';
    if (BAJADA) {
      const corre = blobsDe(path.join(BAJADA, MANIFIESTO_BAJADA));
      const dejado = blobsDe(CONSTANCIA_INSTALADO);
      if (!corre) {
        avisos.push(`🟠 no pude leer el manifiesto de la versión bajada del arnés (${path.join(BAJADA, MANIFIESTO_BAJADA)}): no puedo decir si el freno instalado está al día ni si alguien lo cambió.`);
        if (bibliotecasFaltan.length) aMediasPorBibliotecas();
      } else {
        // 🟠 una constancia que está y no se lee no es «no hay constancia»: sin esto, romperla callaba «alguien lo cambió»
        if (!dejado && existe(CONSTANCIA_INSTALADO)) avisos.push(`🟠 no pude leer la constancia de lo que dejó el instalador del freno (/opt/tycon/production/installed-files.json): no puedo decir si alguien cambió el freno. Reinstalalo: open ${INSTALADOR}`);
        estadoDe = (p) => estadoContraVersionBajada(p.instalado, p.repo, corre, dejado, p.antes);
        textoAlterada = 'el freno instalado NO coincide con la versión del arnés que corre ni con lo que dejó el instalador';
        causaAlterada = 'alguien lo cambió';
      }
    } else if (!PUBLICADO) {
      // una máquina release corrida desde otro árbol y sin clon declarado: no hay con qué comparar y no es un rojo; sólo
      // lo que falta de verdad
      if (bibliotecasFaltan.length) aMediasPorBibliotecas();
    } else if (git(['rev-parse', '--verify', 'origin/main']).status !== 0) {
      // 🟠 y no una línea de pie: sin esto, «lo comparé y está al día» y «no pude compararlo» se veían
      // igual — el aviso callaba entero.
      avisos.push(`🟠 no pude leer lo publicado del arnés (origin/main en ${ARNES}): no puedo decir si el freno instalado está al día ni si alguien lo cambió.`);
      if (bibliotecasFaltan.length) aMediasPorBibliotecas();
    } else {
      estadoDe = (p) => estadoContraPublicado(p.instalado, p.repo, p.antes);
    }
    if (estadoDe) {
      const comparadas = [...piezas, ...bibliotecas.filter((b) => !bibliotecasFaltan.includes(b))];
      const estados = comparadas.map((p) => ({ ...p, estado: estadoDe(p) }));
      const viejas = estados.filter((e) => e.estado === 'vieja');
      const alteradas = estados.filter((e) => e.estado === 'alterada');
      if (alteradas.length) {
        avisos.push(`🔴 ${textoAlterada} (${alteradas.map((a) => a.nombre).join(', ')}): ${causaAlterada}.`);
        avisos.push(`   Reinstalalo desde lo publicado: open ${INSTALADOR}`);
      } else if (viejas.length) {
        avisos.push(`🔴 ${AVISO_VIEJO} (${viejas.map((v) => v.nombre).join(', ')}): el arnés publicó una versión nueva.`);
        if (!instaladoConCopiaPropia(blobsDe(CONSTANCIA_INSTALADO))) avisos.push(TEXTO_COPIA_PROPIA);
        avisos.push(`   Actualizalo (pide tu contraseña del Mac): open ${INSTALADOR}`);
      } else if (bibliotecasFaltan.length) {
        aMediasPorBibliotecas();
      }
      // 🟠 lo que lo publicado no tiene NO se pudo comparar: sin esto se leería igual que «al día»
      const sinComparar = estados.filter((e) => e.estado === 'sin-publicado');
      if (sinComparar.length) avisos.push(`🟠 no pude comparar contra lo publicado: ${sinComparar.map((s) => s.nombre).join(', ')} (lo publicado del arnés no tiene ${sinComparar.length === 1 ? 'ese archivo' : 'esos archivos'}): no puedo decir si está al día ni si alguien lo cambió.`);
      administradaVieja = estados.some((e) => e.instalado === MANAGED && e.estado === 'vieja');
    }
    // las huellas de referencia contra los archivos instalados (AC 29)
    let huellas = null;
    try { huellas = JSON.parse(fs.readFileSync(path.join(OPT, 'huellas.json'), 'utf8')); } catch { /* abajo */ }
    if (!huellas) avisos.push('🔴 no pude leer /opt/tycon/huellas.json: el freno y la puerta no pueden verificar lo que ejecutan. Reinstalalo.');
    else {
      const distintas = Object.entries(huellas)
        .filter(([k]) => k.startsWith('/opt/tycon/'))
        .filter(([k, v]) => sha256(path.join(RAIZ, k)) !== v)
        .map(([k]) => k);
      if (distintas.length) avisos.push(`🔴 estos archivos instalados NO coinciden con su huella: ${distintas.join(', ')}. Reinstalá el freno.`);
    }
    if (!existe(path.join(OPT, 'bin', 'node'))) avisos.push('🔴 falta el intérprete de root (/opt/tycon/bin/node): el freno no puede correr. Reinstalalo.');
    if (!existe(path.join(OPT, 'bin', 'sqlcmd'))) avisos.push('🔴 falta el cliente de base de root (/opt/tycon/bin/sqlcmd): la puerta no puede consultar. Reinstalalo.');
    try {
      const m = JSON.parse(fs.readFileSync(MANAGED, 'utf8'));
      // 🔴 Se revisan TODAS las reglas, no sólo la de la puerta: sacarle a mano la del catálogo o la
      // de la memoria deja editar en silencio los archivos con los que el freno decide qué es
      // producción, y el aviso daba «bien» igual.
      const reglas = ((m.permissions || {}).ask || []).join(' ');
      // los dos nombres del catálogo, del índice y de la memoria. Una administrada de antes del
      // renombre no los tiene, y eso ya lo dijo «quedó viejo»: no se suma otro aviso que parezca un toqueteo.
      const exigidas = administradaVieja ? [] : [
        ['tycon-prod-sql', 'la que abre el cuadro de aprobación de la puerta'],
        ['firewall-rule', 'la que hace aprobar una regla de firewall de producción'],
        ['.tycon/production.json', 'la que hace aprobar un cambio del catálogo de servidores'],
        ['production-index.json', 'la que hace aprobar una edición del índice de producción'],
        ['production-memory.json', 'la que hace aprobar una edición de la memoria de producción'],
        ['.tycon/produccion.json', 'la que hace aprobar un cambio del catálogo con su nombre de antes del renombre'],
        ['produccion-indice.json', 'la que hace aprobar una edición del índice con su nombre de antes del renombre'],
        ['produccion-memoria.json', 'la que hace aprobar una edición de la memoria con su nombre de antes del renombre'],
      ].filter(([clave]) => !reglas.includes(clave));
      if (exigidas.length) {
        avisos.push(`🔴 a la configuración administrada le faltan reglas del cuadro de aprobación: ${exigidas.map(([, q]) => q).join(' · ')}.`);
        avisos.push(`   Reinstalá el freno desde lo publicado: open ${INSTALADOR}`);
      }
    } catch { avisos.push('🔴 no pude leer la configuración administrada del freno.'); }
  }

  // ── 3b. si algo de arriba pide (re)instalar, la ventana del instalador se abre sola ──────────
  // Sin el llavero de producción no se abre: ese dev no toca producción, y la línea del aviso ya dice cómo instalarlo.
  if (!soloPorRepo && avisos.some((a) => a.includes(INSTALADOR)) && abrirInstalador()) {
    avisos.push('   → Te abrí la ventana del instalador: sólo pide tu contraseña del Mac. (Una vez por día; off: TYCON_PRODUCTION_AUTOINSTALL=0)');
  }

  // ── 4. la memoria de producción alterada (queda a la vista hasta que se revise) ──────────────
  if (indice && indice.memoria_alterada) {
    avisos.push('🔴 la memoria de producción fue tocada a mano (su huella no cierra). Mientras tanto el freno no decide nada sobre bases.');
    avisos.push('   Revisala y volvé a sellarla: /opt/tycon/bin/tycon-prod-sql --verificar');
  }

  // ── 5. lo que el freno no pudo decidir (el registro que nadie más lee) ───────────────────────
  try {
    const log = fs.readFileSync(path.join(stateDirOf(HOME), 'hook-errors.log'), 'utf8');
    const hoy = new Date().toISOString().slice(0, 10);
    const propias = log.split('\n\n').filter((l) => l.includes('prod-access-guard') && l.includes(hoy));
    if (propias.length) avisos.push(`🟠 el freno de producción no pudo decidir ${propias.length} vez(ces) hoy (frenó igual). Motivo en ~/.claude/.tycon-pipeline/hook-errors.log`);
  } catch { /* no hay registro: bien */ }

  // ── 6. el pie: qué raíz de repos se usó y cuántos catálogos entraron ────────────────────────
  if (indice) {
    const prod = Object.values(indice.hosts || {}).filter((h) => h.ambiente === 'produccion').length;
    lineas.push(pieDeRaiz(indice, prod, process.cwd(), REPORTE));
    // los errores por repo nombran rutas de la raíz: con el mismo criterio que el pie, a una sesión de afuera sólo se le cuentan
    const errores = (indice.errores || []).filter((e) => !/configuración del arnés ROTA/.test(e.motivo));   // la config rota ya está en `avisos`
    if (REPORTE || sesionDentro(indice.raiz, process.cwd())) for (const e of errores) lineas.push(`   ⚠ ${e.repo}: ${e.motivo}`);
    else if (errores.length) lineas.push(`   ⚠ ${errores.length} proyecto(s) con su catálogo de servidores ilegible (el detalle, con --report)`);
    // sin catálogos en una máquina autorizada, TODO host se frena: eso se dice aunque no haya otro aviso
    if (!indice.catalogos.length) avisos.push('🟠 ningún proyecto de esta máquina declara servidores: TODO host de base se va a tratar como producción (¿la raíz de repos está bien?).');
  }

  if (soloPorRepo && avisos.length) {
    try {
      fs.mkdirSync(path.dirname(SELLO_SIN_LLAVERO), { recursive: true });
      fs.writeFileSync(SELLO_SIN_LLAVERO, new Date().toISOString().slice(0, 10) + '\n');
      avisos.push('   Este aviso sale una sola vez: esta máquina no tiene el llavero de producción. Si te toca producción, instalá el freno con el comando de arriba.');
    } catch { /* sin sello, vuelve a salir: mejor que callarlo */ }
  }

  if (avisos.length || REPORTE) {
    console.log('');
    if (!avisos.length) console.log('✅ freno de producción: instalado, al día y con sus huellas.');
    for (const a of avisos) console.log(a);
    for (const l of lineas) console.log(l);
  }
  process.exit(0);
}

/**
 * El pie del aviso: qué raíz de repos se usó. La ruta se nombra sólo si la sesión corre dentro de ella (o la pidió una
 * persona con --report): a una sesión que arrancó en otra carpeta, una copia de laboratorio por ejemplo, la ruta de la
 * raíz le indica dónde están los repos de verdad, y un modelo la tomó como su lugar de trabajo.
 */
function sesionDentro(raiz, cwd) {
  const rel = path.relative(raiz, cwd);
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function pieDeRaiz(indice, prod, cwd, reporte) {
  const raiz = sesionDentro(indice.raiz, cwd) || reporte ? `${indice.raiz} (${indice.fuente})` : 'otra carpeta, fuera de la de esta sesión';
  return `   raíz de repos: ${raiz} · catálogos: ${indice.catalogos.length} · servidores de producción conocidos: ${prod}`;
}

if (COMO_MODULO) {
  // para las pruebas: el juicio contra lo publicado, sin correr el aviso
  module.exports = { pieDeRaiz, sesionDentro, estadoContraPublicado, estadoContraVersionBajada, blobsDe, rutasViejas, AVISO_VIEJO, BIBLIOTECAS_DEL_FRENO, COPIA_PROPIA, TEXTO_COPIA_PROPIA, instaladoConCopiaPropia };
} else {
  try { main(); } catch (e) {
    // un aviso que se rompe no puede romper el arranque de la sesión
    console.log(`🟠 produccion-notice: no pude chequear el freno de producción (${e.message})`);
    process.exit(0);
  }
}
