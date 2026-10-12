'use strict';
/**
 * closing-record.js — la constancia de los tres hooks del CIERRE (story 7.2 del arnés, 2026-09-16).
 *
 * `on-frontmatter-write.js`, `on-pre-commit.js` y `on-dod-evidence-guard.js` son los frenos que
 * impiden cerrar una story sin evidencia. No dejaban rastro de lo que decidían, así que el número que
 * dice si el cierre recortado alcanza —cuántas veces rechazan una evidencia— no existía. Acá se anota
 * UNA línea por decisión en `~/.claude/.tycon-pipeline/frenos.jsonl`, con la lib del arnés
 * (`~/.claude/tycon-harness/scripts/lib/guard-record.js`: listas cerradas, sólo la huella).
 *
 * 🔴 ES AYUDA, NO EVIDENCIA. Nunca tira, nunca escribe a stdout/stderr y nunca cambia lo que el hook
 *    decide ni con qué código sale (regla de la story 2.6). Sin el arnés en la máquina —un dev que
 *    tiene agent-skills y no el repo de guías— no se anota nada y el hook sigue igual: esa ausencia no
 *    es una falla, y anotarla en cada edición sería ruido. Un error AL CARGAR una lib que sí está
 *    (sintaxis, permisos) sí es anómalo y queda en `hook-errors.log`.
 *
 * Interruptor: `TYCON_CLOSURE_RECORD=off` no anota nada. Es para las PRUEBAS que corren estos hooks con el HOME
 * real (las de agent-skills lo ponen); no es un apagado del freno, que decide igual.
 *
 * 🔴 LA HUELLA, NUNCA EL DATO: quien llama pasa `huella` (p. ej. id de story + estado nuevo, o la ruta
 *    del archivo) y la lib guarda su sha256. Ni ruta, ni story, ni texto del commit viajan en la línea.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateDir: stateDirOf } = require('./state-dir.js');   // story 8.23 (A2): la carpeta del estado, de una sola pieza
/**
 * El nombre de la lib del arnés: el nuevo, y el que tenía hasta la tanda C1 de la story 8.9 (renombrada con
 * reemplazo). 🔴 Primero el nuevo: bajo Azure (TF_BUILD) el reemplazo del nombre viejo escribe un aviso por stderr, y
 * cargarlo hacía que el hook cambiara su salida según estuviera o no la lib (7.2-T2 de guard-record.test.sh, rojo
 * sólo en Azure). El viejo queda para una máquina con el arnés atrasado, que todavía no trae el nuevo. Se arma de sus
 * partes: entero lo cuentan el freno y el termómetro de nombres viejos.
 */
const NOMBRES_DE_LA_LIB = Object.freeze({ nuevo: 'guard-record.js', viejo: `${['constancia', 'freno'].join('-')}.js` });

/** Dónde está la lib del arnés: `TYCON_GUIDES_DIR`, el lugar ~/.claude/tycon-harness o el nombre viejo, en ese orden
 *  (lib/harness-path.js, stories 8.3 y 8.19), con su nombre nuevo o, si sólo está ése, el viejo. Sin arnés (o sin
 *  ninguna de las dos) devuelve la ruta del nombre nuevo bajo el lugar igual: no existe, y quien la lee ya dice «sin-lib». */
function rutaDeLaLib() {
  const hp = require('./harness-path.js');
  const r = hp.rutaArnesHook();
  const base = r.dir || hp.enlace(os.homedir());
  const dir = path.join(base, 'scripts', 'lib');
  const nueva = path.join(dir, NOMBRES_DE_LA_LIB.nuevo);
  if (fs.existsSync(nueva)) return nueva;
  const vieja = path.join(dir, NOMBRES_DE_LA_LIB.viejo);
  return fs.existsSync(vieja) ? vieja : nueva;
}

function anotarErrorDeCarga(motivo) {
  try {
    const dir = path.join(stateDirOf(os.homedir()));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-errors.log'),
      `[${new Date().toISOString()}] constancia-cierre: la lib del arnés existe pero no cargó (${motivo}) — la decisión del hook no quedó anotada\n`, 'utf8');
  } catch { /* ayuda, no evidencia: ni esto puede tumbar al hook */ }
}

/**
 * Anota una decisión de un hook del cierre. Devuelve `{ escrito, motivo? }` (para pruebas).
 * @param {{ freno: string, regla: string, veredicto: 'bloqueo'|'paso'|'aviso', huella?: string }} d
 */
function anotarCierre({ freno, regla, veredicto, huella } = {}) {
  // Las suites de agent-skills que llaman a estos hooks con el HOME real lo apagan: sus decisiones son de prueba y
  // no pueden mezclarse con las del equipo en el buzón (pase adversarial de la vuelta 1).
  if (String(require('./legacy-names.js').readEnv('TYCON_CLOSURE_RECORD', { where: 'skills/tycon-pipeline/scripts/lib/closing-record.js' }) || '').toLowerCase() === 'off') return { escrito: false, motivo: 'apagada' };
  const lib = rutaDeLaLib();
  if (!fs.existsSync(lib)) return { escrito: false, motivo: 'sin-lib' };
  let mod;
  try {
    mod = require(lib);
  } catch (e) {
    anotarErrorDeCarga((e && e.code) || (e && e.message && e.message.slice(0, 80)) || 'error desconocido');
    return { escrito: false, motivo: 'lib-no-carga' };
  }
  try {
    return mod.anotar({ freno, regla, veredicto, cmd: typeof huella === 'string' ? huella : undefined });
  } catch (e) {
    // `anotar` promete no tirar; si igual tira, es un defecto de la lib: que quede escrito.
    anotarErrorDeCarga(`anotar tiró: ${(e && e.message && e.message.slice(0, 80)) || 'error desconocido'}`);
    return { escrito: false, motivo: 'anotar-tiro' };
  }
}

module.exports = { anotarCierre, rutaDeLaLib, NOMBRES_DE_LA_LIB };
