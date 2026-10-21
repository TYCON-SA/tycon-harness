#!/usr/bin/env node
/**
 * engram-drift-notice.js — hook SessionStart: grita si la memoria persistente de algún repo está
 * partida en varios nombres, no tiene nombre fijado, o nunca salió de esta máquina.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────
 * engram autodetecta el project name desde el basename del cwd cuando el repo no lo fija. Cada
 * variante —un rename de carpeta, una sesión desde una subcarpeta, alguien tipeando el nombre a
 * mano— abre un cajón nuevo. Y **falla en silencio**: `mem_search` con el nombre equivocado
 * devuelve "no memories found", que es EXACTAMENTE lo mismo que devuelve un repo sin historia. Una
 * sesión puede arrancar sin ninguna referencia previa y nadie se entera.
 *
 * Sin este aviso, un repo termina con su memoria partida en varios nombres y con muchas observaciones que
 * nunca se exportaron a ningún chunk — o sea que viven en UNA sola máquina y se pierden con el
 * disco.
 *
 * 🔴 La razón de que esto sea un HOOK y no sólo un check del scorecard: los tres chequeos ya
 * existían en `harness-audit.js`, pero ese script **sólo corre si alguien se acuerda de correrlo**.
 * Un repo nuevo sin nombre declarado no avisaría hasta la próxima revisión manual. Es la misma
 * regla que el arnés ya tiene escrita: *un control que hay que acordarse de invocar es un control
 * que no corre.* Acá se cobra solo, al arrancar la sesión.
 *
 * Diseño:
 *   · Reusa los chequeos de harness-audit.js — NO los reimplementa. Una sola fuente de verdad:
 *     si el criterio cambia allá (normalizar mayúsculas, excluir transversales, exigir memoria
 *     viva), este hook lo hereda sin tocarse.
 *   · Throttle 24h. La consulta toca sqlite y descomprime chunks; en cada arranque sería un peaje
 *     por nada, y un aviso que aparece siempre se lee como ruido.
 *   · Silencio total en verde. Sólo habla cuando hay algo que hacer.
 *   · Fail-open absoluto: cualquier excepción → exit 0 mudo. Un hook de arranque NUNCA puede
 *     romper el arranque.
 *
 * Opt-out: TYCON_ENGRAM_DRIFT=0
 * Forzar (ignora el throttle): --force
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
if (process.env.TYCON_ENGRAM_DRIFT === '0' || process.env.TYCON_EVAL_SANDBOX === '1') process.exit(0);

// engram: con la integración apagada (sin perfil del equipo ni llave) no hay memoria que revisar —
// se dice en UNA línea y sale 0, nunca «0 repos» en verde. El instalador no registra este hook apagada; esto cubre la
// corrida a mano y la máquina que lo tiene registrado. Configuración ROTA: el aviso en cada arranque, sin revisar
// Sin la lib al lado (hook copiado a un arnés de mentira): con la integración prendida — fail-open.
try {
  const cfg = require(path.join(__dirname, '..', 'lib', 'tycon-config.js'));
  if (typeof cfg.integracionParaHook === 'function') {
    const e = cfg.integracionParaHook('engram', { interruptor: 'TYCON_ENGRAM_DRIFT' });   // =1 manda sobre la llave apagada
    if (!e.ok) { console.log(e.aviso); process.exit(0); }
    if (!e.prendida) { console.log(`${e.apagada} — la revisión diaria de la memoria no corre`); process.exit(0); }
  }
} catch (e) {
  // sin la lib al lado: como hoy. Otro error del lector se dice y se sigue (un hook no frena ni calla).
  if (!(e && e.code === 'MODULE_NOT_FOUND')) console.log(`engram-drift-notice: el lector de configuración falló (${e && e.message}) — sigo como si engram estuviera prendida`);
}

const FORCE = process.argv.includes('--force');
const STAMP = path.join(stateDirOf(os.homedir()), 'engram-drift-last-run');
const CADA_MS = 24 * 60 * 60 * 1000;

function vencido() {
  if (FORCE) return true;
  try {
    const t = Date.parse(fs.readFileSync(STAMP, 'utf8').trim());
    // Un stamp ilegible cuenta como vencido: preferimos un chequeo de más a un silencio que no
    // sabemos si es verde o una fecha rota.
    return isNaN(t) || (Date.now() - t) > CADA_MS;
  } catch { return true; }
}

function sellar() {
  try {
    fs.mkdirSync(path.dirname(STAMP), { recursive: true });
    fs.writeFileSync(STAMP, new Date().toISOString());
  } catch { /* no poder sellar no es motivo para no avisar */ }
}

try {
  if (!vencido()) process.exit(0);

  const audit = require(path.join(__dirname, '..', 'lib', 'harness-audit.js'));
  const problemas = [];
  // 🔴 Lo que NO se pudo verificar se rastrea aparte y BLOQUEA el sello del día.
  // Sin esto, un error de escaneo o una consulta rota saldrían por un catch,
  // el hook no diría nada, Y sellaría igual — con lo que la máquina quedaría 24 h sin chequear y
  // sin que nadie lo supiera. Un chequeo que no corrió no puede consumir su propia ventana.
  const sinVerificar = [];

  // 🔴 "No pude revisar" NO es "está todo bien". Tres de los cuatro chequeos consultan la base de
  // engram con `sqlite3`, y sin ese binario devuelven null — que el hook se tragaría en
  // silencio. O sea: en una máquina sin sqlite3 (Windows sin instalarlo, por ejemplo) TODO esto
  // quedaría inerte y nadie se enteraría. Es exactamente el modo de falla que este hook existe para
  // cazar, adentro del hook. Se detecta una vez y se dice, con cómo resolverlo.
  // Si NO hay base de engram, no hay nada que verificar: los chequeos que la leen se saltean sin
  // ruido. Distinto de "la base está y no se pudo leer", que sí es no saber.
  const HAY_BASE = fs.existsSync(path.join(os.homedir(), '.engram', 'engram.db'));

  const haySqlite = (() => {
    try { require('child_process').execFileSync(process.env.TYCON_SQLITE_BIN || 'sqlite3', ['-version'], { stdio: 'ignore' }); return true; }
    catch { return false; }
  })();
  if (!haySqlite && HAY_BASE) {
    problemas.push(
      'No puedo revisar el estado de la memoria en esta máquina: falta `sqlite3`.\n' +
      '     Quedan SIN correr 2 de los 4 chequeos: memoria partida en varios nombres, y memoria que\n' +
      '     nunca se exportó. Eso NO es lo mismo que estar bien: es no saber. Los otros dos —repos\n' +
      '     sin nombre declarado, y chunks fuera del índice— SÍ corrieron: sólo miran archivos.\n' +
      '     🔴 Tener engram no alcanza: engram lleva su propio SQLite compilado adentro\n' +
      '     (modernc.org/sqlite), así que NO instala el comando `sqlite3`. En macOS/Linux viene con\n' +
      '     el sistema; en Windows hay que instalarlo aparte: `winget install SQLite.SQLite`.');
  }

  // 1. Repos sin el nombre fijado — la CAUSA. Barato, no toca la DB.
  const escaneo = audit.scanEngramRepos();
  // 🔴 El arreglo se imprime con RUTA ABSOLUTA y por repo. Una ruta relativa como
  // `node scripts/…/engram-rescue-unexported.js --reindex --apply` sólo existe si estás parado
  // en el clon del arnés: desde cualquier otra carpeta —que es donde estás cuando leés este aviso
  // al abrir una sesión— el comando no corre. Y sin `--repo` tocaría todos los repos, no el que
  // está roto. `__dirname` lo resuelve para cualquier clon, en cualquier máquina.
  const arregloDe = (r) => `node ${JSON.stringify(path.join(__dirname, '..', 'lib', 'manifest-engram.js'))}`
    + ` repair --apply --repo ${JSON.stringify(r.dir || path.join(escaneo.root, r.repo))}`;   // con varias carpetas de repos, la del propio repo
  const { unpinned } = escaneo;
  // 🔴 SIN RAÍZ DE REPOS: el arnés no sabe dónde están los repos de esta máquina. Eso deja sin correr los
  // chequeos que miran repos —y el de la memoria nunca exportada devuelve null por eso, que este aviso leería como «¿base
  // corrupta?» con la base sana. Se dice UNA vez, con el motivo y cómo declararla, y los chequeos que la necesitan no corren.
  const sinRaiz = !escaneo.root;
  if (sinRaiz) {
    let motivo = '';
    try { const rr = require(path.join(__dirname, '..', 'lib', 'repos-root.js')); motivo = rr.describir(rr.resolveReposRoot()); } catch (_) { motivo = 'sin raíz de repos'; }
    sinVerificar.push(`no sé dónde están tus repos, así que no pude revisar su memoria (repos sin nombre fijado, memoria partida, chunks fuera del índice ni memoria sin exportar) — ${motivo}. No es la base de engram: es que falta saber dónde mirar`);
  } else if (escaneo.error) sinVerificar.push(`no se pudieron escanear los repos — ${escaneo.error}`);
  if (unpinned.length) {
    problemas.push(
      `${unpinned.length} repo(s) con memoria pero SIN nombre de proyecto fijado: ${unpinned.map((r) => r.repo).join(', ')}.\n` +
      '     Sin eso engram lo adivina desde el nombre de la carpeta y la memoria se parte sola, sin dar error.\n' +
      '     Arreglo: crear <repo>/.engram/config.json con {"project_name": "<el nombre>"} y commitearlo.');
  }

  // 2. Memoria ya partida — el SÍNTOMA. Acá el hook NO se limita a avisar: lo que es inequívoco lo
  //    UNE SOLO. El nombre canónico ya viaja por git (`.engram/config.json`), pero el arreglo de la
  //    base LOCAL no viaja: cada máquina importó los chunks viejos con el nombre viejo y el import
  //    dedupea por sync_id, así que sin esto cada dev tendría que entender el problema y correr la
  //    unificación a mano.
  //
  //    Se une SÓLO lo que no puede estar bien de otra manera — tres guardas por datos, probadas en
  //    `scripts/tests/engram-autoheal.test.js`. Lo ambiguo se reporta con el motivo. La guarda que
  //    más importa: si la carpeta de un producto guarda observaciones de OTRO, un automatismo ingenuo
  //    se las lleva adentro sin vuelta atrás.
  try {
    if (sinRaiz) throw Object.assign(new Error('sin raíz de repos'), { sinRaiz: true });
    if (!haySqlite || !HAY_BASE) throw new Error('sin sqlite3 o sin base');
    const heal = require(path.join(__dirname, '..', 'lib', 'engram-autoheal.js'));
    const { plan, motivo, sinBase } = heal.planificar();
    if (motivo && !sinBase) sinVerificar.push(`no se pudo planificar la unificación — ${motivo}`);
    const conAuto = plan.filter((r) => r.auto.length);
    const conHumano = plan.filter((r) => r.humano.length);

    // 🔴 EL APPLY AUTOMÁTICO ESTÁ APAGADO. Se avisa y se da el comando; NO se ejecuta solo.
    //
    // Por qué está apagado, en orden de gravedad:
    //  · La COMPROBACIÓN POSTERIOR no comprueba lo que dice. Exige que el cajón de origen
    //    quede en cero y que ningún otro DISMINUYA. Un BORRADO deja el origen en cero, así
    //    que pasa como éxito. Un destino EQUIVOCADO hace que ese cajón AUMENTE, y sólo se
    //    miran disminuciones: también pasa. Y nunca se verifica que el pin correcto
    //    haya recibido nada. O sea: la red con la que se justificaría automatizar algo
    //    irreversible no atrapa ni el borrado ni el destino errado.
    //  · CARRERA en la selección. El motor es `engram projects consolidate`, una interfaz
    //    NUMERADA para humanos: el script lee la lista con `--dry-run` y responde el número en
    //    OTRA invocación. Si la oferta cambia en el medio —dos sesiones abiertas a la vez, por
    //    ejemplo— el mismo número significa otro proyecto. Un candado y comparar la lista entera
    //    REDUCEN el riesgo; no lo eliminan. El arreglo de fondo es que engram exponga una unión
    //    no interactiva por nombre: es un pedido upstream, no algo parchable desde acá.
    //  · Las guardas se apoyan en la lista de repos con pin, así que un repo no clonado, borrado
    //    o con su config corrupta deja de proteger a su proyecto.
    //
    // El resto (detectar, avisar, el rescate manual) queda intacto: no muta nada solo.
    // Reactivar exige, como mínimo: verificación por IDENTIDAD de observaciones —no por
    // conteos— y una operación de unión no interactiva del lado de engram.
    if (conAuto.length) {
      problemas.push(
        'Memoria partida que se puede unificar sin ambigüedad — hay que correrlo A MANO:\n' +
        conAuto.flatMap((r) => r.auto.map((a) =>
          `       · en ${r.repo}: '${a.nombre}' (${a.obs} obs) → '${r.pin}'`)).join('\n') + '\n' +
        '     Revisá y aplicá:  node ~/.claude/tycon-harness/scripts/lib/engram-autoheal.js\n' +
        '     (sin --apply muestra el plan · con --apply lo ejecuta)\n' +
        '     🔴 El apply automático está APAGADO a propósito: su verificación posterior no\n' +
        '     detectaba un borrado ni un destino equivocado, y el motor tiene una carrera.\n' +
        '     Detalle en el comentario de este archivo.');
    }

    if (conHumano.length) {
      problemas.push(
        'Memoria partida que NO se toca sola, porque no es inequívoca:\n' +
        conHumano.flatMap((r) => r.humano.map((h) =>
          `       · en ${r.repo}: '${h.nombre}' (${h.obs} obs) — ${h.motivo}`)).join('\n') + '\n' +
        '     Si son del mismo producto, unilos vos:\n' +
        conHumano.map((r) => `       cd ${r.dir} && engram projects consolidate --dry-run`).join('\n') + '\n' +
        '     Elegí por número SÓLO los que correspondan. NUNCA `all`: su emparejador ofrece proyectos ajenos.');
    }
  } catch (e) {
    if (e && e.sinRaiz) { /* dicho arriba, una vez */ } else if (haySqlite && HAY_BASE) sinVerificar.push(`falló el chequeo de memoria partida: ${String(e && e.message || e).slice(0, 120)}`);
    // Sin el autoheal (clon viejo), se cae al aviso de siempre: mejor avisar que callar.
    const partida = haySqlite && !sinRaiz ? audit.engramDirsWithMultipleProjects() : null;
    if (partida && partida.length) {
      problemas.push(
        `${partida.length} directorio(s) con memoria repartida en varios nombres: ` +
        partida.map((d) => path.basename(d.dir)).join(', ') + '\n' +
        '     Unificar: fijar el nombre en .engram/config.json y después `engram projects consolidate`,\n' +
        '     con selección EXPLÍCITA por número — NUNCA `--all`.');
    }
  }

  // 3. Chunks fuera del índice: commiteados y de todos modos ilegibles para el equipo. Es el
  //    eslabón entre el archivo y el índice, y no lo cubre ninguno de los otros tres.
  try {
    const desind = sinRaiz ? null : audit.engramChunksSinIndexar();   // no necesita sqlite3: sólo archivos
    if (desind && desind.length) {
      const totSin = desind.reduce((a, r) => a + (r.sinIndexar || []).length, 0);
      problemas.push(
        `${totSin} chunk(s) de memoria están en el repo pero NO en su índice — commiteados y aun así ilegibles para el equipo:\n` +
        desind.map((r) => `       · ${r.repo}: ${(r.sinIndexar || []).join(', ') || '(entradas sin archivo)'}`).join('\n') + '\n' +
        '     `engram sync --import` usa el índice para saber qué levantar: un chunk sin entrada se ve\n' +
        '     igual que un archivo que no existe. Arreglo, por repo:\n' +
        desind.map((r) => `       ${arregloDe(r)}`).join('\n'));
    }
  } catch (e) { sinVerificar.push(`falló el chequeo de chunks fuera del índice: ${String(e && e.message || e).slice(0, 120)}`); }

  // 4. Memoria que nunca viajó — la más cara: no se recupera.
  const varadas = (haySqlite && HAY_BASE && !sinRaiz) ? audit.engramUnexportedByRepo() : null;
  if (haySqlite && HAY_BASE && !sinRaiz && varadas === null) sinVerificar.push('no se pudo leer la base de engram para ver qué memoria nunca se exportó (¿base corrupta, permisos, sqlite3 roto?)');
  if (varadas && varadas.length) {
    const total = varadas.reduce((a, r) => a + r.varadas, 0);
    problemas.push(
      `${total} observación(es) existen SÓLO en esta máquina — nunca se exportaron a .engram/chunks:\n` +
      varadas.map((r) => `       · ${r.repo} (${r.project}): ${r.varadas} de ${r.total}`).join('\n') + '\n' +
      '     Si se pierde el disco, se pierden. Nadie más del equipo las tiene.\n' +
      '     Arreglo por repo: `engram sync --project <nombre>` y commitear .engram/');
  }

  if (sinVerificar.length) {
    problemas.push(
      'Hay chequeos que NO pudieron correr — esto NO es "está todo bien", es "no sé":\n' +
      sinVerificar.map((x) => `       · ${x}`).join('\n') + '\n' +
      '     Por eso NO se sella el día: se vuelve a intentar en el próximo arranque.');
  }

  // Sólo se sella si se pudo verificar todo. Si algo quedó sin correr, el día no se consume:
  // volver a intentar mañana sería tarde, y peor: parecería verde.
  if (!sinVerificar.length) sellar();

  if (!problemas.length) process.exit(0);

  console.log('🧠 memoria de engram — revisión diaria:');
  problemas.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  console.log('  Detalle y score: node ~/.claude/tycon-harness/scripts/lib/harness-audit.js --verbose');
  console.log('  Silenciar: TYCON_ENGRAM_DRIFT=0');
} catch (e) {
  // Fail-open absoluto — ver cabecera. Con UNA excepción que se dice: la configuración del
  // arnés rota (~/.claude/tycon.json o el perfil) no se lee como «todo bien» ni como «sin repos»: se avisa en
  // CADA arranque, sin sello, y esta revisión no corre. Nunca sale ≠ 0 por esto.
  if (e && e.name === 'ConfigError') {
    try { console.log(require(path.join(__dirname, '..', 'lib', 'tycon-config.js')).avisoParaHook(e.errores)); }
    catch { console.log(String(e.message || e)); }
    console.log('  (la revisión diaria de la memoria no corrió por eso)');
  }
}
process.exit(0);
