#!/usr/bin/env node
'use strict';
/**
 * scripts/lib/skills-dir.js — DÓNDE están las skills: la resolución de `TYCON_SKILLS_DIR`, tolerante a las dos
 * semánticas que conviven en el arnés, y —sin variable— el propio clon antes que lo instalado.
 *
 * ── LAS DOS LECTURAS DE LA VARIABLE ────────────────────────────────────────────────────────────────
 * La variable significa cosas OPUESTAS según quién la lea, y las dos
 * están DOCUMENTADAS en mensajes al dev: los deployers de Codex la toman como la RAÍZ del clon de agent-skills
 * (`deploy-shared-skills` le agrega `skills`), mientras el lint de stories y el backfill la toman como la CARPETA
 * de skills y sus propios errores instruyen exportarla así. Estandarizar hacia cualquiera de los dos lados rompe a
 * la población que siguió la instrucción del otro — con rojos falsos permanentes, que es como un control se gana
 * el opt-out. La salida: aceptar los dos. Se decide mirando el disco, no adivinando:
 *   - si <valor>/skills existe → era la raíz;
 *   - si no, y <valor> parece la carpeta de skills (termina en /skills o contiene un SKILL.md un nivel abajo) →
 *     era la carpeta, la raíz es su padre.
 *
 * ── EL PROPIO CLON PRIMERO ─────────────────────────────────────────────────────────────
 * Los dos repos internos se unen en uno, con `skills/` y `agents/` en la raíz. Sin variable, si el clon donde vive
 * este archivo es unido, las skills son las suyas: contestar siempre `~/.claude/agent-skills` haría que una prueba
 * corrida en un clon de trabajo del repo unido leyera las skills INSTALADAS en la máquina y diera verde sin haber
 * probado el cambio.
 *
 * 🔴 CONTRATO — lo usan los otros carriles, los pipelines y el instalador. NO se cambia sin
 *    avisar: ni la firma, ni el orden, ni los códigos de salida.
 *
 *   resolveSkillsDirs([valor]) → { repo, skills, source }                          ← para quien LEE las skills
 *     1. la variable `TYCON_SKILLS_DIR` (o `valor`, si se pasa; '' = «sin variable»)      → source: 'variable'
 *     2. el propio clon, si es unido — `isSingleRepo()` de canonical-path.js:
 *        trae skills/tycon-pipeline y agents/ en su raíz                                  → source: 'own-clone'
 *     3. `~/.claude/agent-skills`, exista o no (lo de siempre)                            → source: 'installed'
 *     `repo` es la raíz (la que trae `skills/` y `agents/`); `skills`, la carpeta de skills.
 *     Con dos repos físicos (el clon del arnés sin `skills/`) no cambia nada: 1 y 3 son lo que había.
 *
 *   resolveInstalledSkillsDirs([valor]) → { repo, skills, source }      ← para quien ESCRIBE rutas en la máquina
 *     1. la variable                                                                      → 'variable'
 *     2. `~/.claude/agent-skills`, si existe (la carpeta, o el enlace: se devuelve su ruta) → 'installed'
 *     3. lo que diga resolveSkillsDirs() (el propio clon si es unido; si no, lo instalado)
 *     POR QUÉ: los desplegadores del lado Codex escriben esta ruta en
 *     `~/.codex/hooks.json` y enlazan `~/.codex/skills` hacia ella. Con «el propio clon primero», apenas el clon
 *     del arnés de una máquina del equipo trae `skills/` —con el clon de skills de siempre
 *     todavía instalado— pasarían a escribir la ruta del clon del arnés, sin que nadie haya movido la llave. Los
 *     comandos de `hooks.json` que nombran las skills cambiarían todos (y Codex aprueba los
 *     hooks por hash: habría que re-aprobarlos), y los enlaces que apuntan a la ruta de siempre dejarían de reconocerse
 *     como propios: quedarían como «del dev», sin actualizarse ni limpiarse. Quien escribe en la máquina escribe la
 *     ruta INSTALADA mientras exista; es además la estable cuando el clon vive en cualquier carpeta.
 *
 *   Desde bash (el instalador, los pipelines):
 *     node scripts/lib/skills-dir.js --skills [--installed]    → la carpeta de skills, una línea
 *     node scripts/lib/skills-dir.js --repo   [--installed]    → la raíz, una línea
 *     node scripts/lib/skills-dir.js --source [--installed]    → variable | own-clone | installed
 *     Sale 0 con la línea escrita · 1 si la carpeta de skills resuelta NO existe (sin nada en stdout y con el
 *     motivo en stderr: quien captura la salida no se queda con una carpeta fantasma) · 2 por uso.
 *       SK="$(node "$CLON/scripts/lib/skills-dir.js" --skills)" || { echo "sin skills: no se mide"; exit 1; }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const OWN_CLONE = path.resolve(__dirname, '..', '..');
// dónde viven las skills instaladas lo sabe scripts/setup/harness/tycon-home.js. Se carga
// SI ESTÁ, por su ruta relativa: la copia de este archivo que viaja al freno de producción (/opt/tycon/lib/) lo encuentra
// en /opt/tycon/setup/harness/ (misma posición relativa; lo copia su instalador) y, si no está, vale la ruta de siempre.
const TYCON_HOME_LIB = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js');
const tyconHome = fs.existsSync(TYCON_HOME_LIB) ? require(TYCON_HOME_LIB) : null;
const installedRepo = () => (tyconHome && typeof tyconHome.installedSkillsDir === 'function' ? tyconHome.installedSkillsDir(os.homedir()) : path.join(os.homedir(), '.claude', 'agent-skills'));

/** La variable, en sus dos lecturas (raíz o carpeta de skills). */
function fromVariable(v) {
  const dado = path.resolve(v);
  if (fs.existsSync(path.join(dado, 'skills'))) return { repo: dado, skills: path.join(dado, 'skills'), source: 'variable' };
  const pareceSkills = path.basename(dado) === 'skills'
    || (() => { try { return fs.readdirSync(dado).some((d) => fs.existsSync(path.join(dado, d, 'SKILL.md'))); } catch { return false; } })();
  if (pareceSkills) return { repo: path.dirname(dado), skills: dado, source: 'variable' };
  return { repo: dado, skills: path.join(dado, 'skills'), source: 'variable' };
}

const valueOf = (envValue) => (envValue !== undefined ? envValue : process.env.TYCON_SKILLS_DIR);

/**
 * ¿El clon donde vive este archivo es el repo unido? Lo dice `isSingleRepo()` de canonical-path.js (contrato C4, del
 * carril de las máquinas): se usa, no se vuelve a escribir. Se importa acá adentro y no arriba porque
 * canonical-path.js importa legacy-names.js, que importa este archivo.
 *
 * Una copia SUELTA de este archivo —sin canonical-path.js al lado— no es un clon, y no es unido: así viaja al freno
 * de producción instalado (`/opt/tycon/lib`, scripts/production/install-guard.sh) y a los laboratorios de varias
 * pruebas, y ahí tiene que contestar lo de siempre. Sólo «no está»: una biblioteca que está y no carga NO se lee
 * como «no es unido» (sería volver a leer las skills instaladas, callado).
 *
 * 🔴 «No está» es que falte canonical-path.js, y nada más.
 *    Leer el MODULE_NOT_FOUND de CUALQUIER `require` de su cadena como «copia incompleta» sería un error: en un clon
 *    unido, un `require` a un archivo que el cambio bajo prueba movió (en canonical-path.js o en legacy-names.js)
 *    haría que todos los lectores pasaran a las skills INSTALADAS con código 0 —el verde que no probó nada—. Si la
 *    vecina está y no carga, por lo que sea, tira; y cuando lo que falta
 *    es un archivo, el mensaje dice cuál y quién lo pide. Quien copia canonical-path.js copia también lo que importa.
 *
 * Por eso la vecina se carga SI ESTÁ, por su ruta, y no con un `require` literal: es una dependencia opcional. El
 * control de cierre del freno de producción (T25 de legacy-names.test.js) exige que todo `require` literal de lo que
 * se copia a /opt también se copie; llevar canonical-path.js a /opt sumaría una biblioteca más cuyo cambio pide
 * reinstalar el freno con sudo en cada máquina autorizada, para una regla («el propio clon») que allá no aplica.
 */
function ownCloneIsUnified() {
  const neighbor = path.join(__dirname, 'canonical-path.js');
  if (!fs.existsSync(neighbor)) return false;
  let lib;
  try {
    lib = require(neighbor);
  } catch (e) {
    if (!e || e.code !== 'MODULE_NOT_FOUND') throw e;
    // Node ya nombra lo que falta («Cannot find module './x.js'») y quién lo pidió (requireStack): se dice entero
    const what = String(e.message || e).split('\n')[0];
    const asker = Array.isArray(e.requireStack) && e.requireStack.length ? e.requireStack[0] : neighbor;
    const err = new Error(`skills-dir: ${neighbor} está pero no carga — ${what} (lo pide ${asker}). `
      + 'No lo leo como «este clon no es unido»: sería medir las skills instaladas en vez de las de este clon. '
      + 'Arreglá ese require, o decí dónde están las skills con TYCON_SKILLS_DIR.');
    err.code = 'SKILLS_DIR_NEIGHBOR_BROKEN';   // no MODULE_NOT_FOUND: quien atrapa «falta skills-dir.js» no lo confunde
    err.cause = e;
    throw err;
  }
  return lib.isSingleRepo(OWN_CLONE);
}

/** @returns {{repo: string, skills: string, source: 'variable'|'own-clone'|'installed'}} */
function resolveSkillsDirs(envValue) {
  const v = valueOf(envValue);
  if (v) return fromVariable(v);
  if (ownCloneIsUnified()) return { repo: OWN_CLONE, skills: path.join(OWN_CLONE, 'skills'), source: 'own-clone' };
  const repo = installedRepo();
  return { repo, skills: path.join(repo, 'skills'), source: 'installed' };
}

/** Para quien ESCRIBE rutas en la máquina: la instalada mientras exista (ver la cabecera). */
function resolveInstalledSkillsDirs(envValue) {
  const v = valueOf(envValue);
  if (v) return fromVariable(v);
  const repo = installedRepo();
  if (fs.existsSync(path.join(repo, 'skills'))) return { repo, skills: path.join(repo, 'skills'), source: 'installed' };
  return resolveSkillsDirs('');
}

const USAGE = 'uso: node skills-dir.js --skills | --repo | --source  [--installed]\n';
const FIELDS = { '--skills': 'skills', '--repo': 'repo', '--source': 'source' };

function main(argv) {
  const asked = argv.filter((a) => a in FIELDS);
  const unknown = argv.filter((a) => !(a in FIELDS) && a !== '--installed');
  if (asked.length !== 1 || unknown.length) {
    process.stderr.write(USAGE);
    return 2;
  }
  const dirs = argv.includes('--installed') ? resolveInstalledSkillsDirs() : resolveSkillsDirs();
  let isDir = false;
  try { isDir = fs.statSync(dirs.skills).isDirectory(); } catch (_) { isDir = false; }
  if (!isDir) {
    const why = dirs.source === 'variable'
      ? `variable — TYCON_SKILLS_DIR=${process.env.TYCON_SKILLS_DIR}`
      : `installed — sin TYCON_SKILLS_DIR, y ${OWN_CLONE} no trae skills/tycon-pipeline y agents/`;
    process.stderr.write(`skills-dir: la carpeta de skills no existe: ${dirs.skills} (salió de: ${why})\n`);
    return 1;
  }
  process.stdout.write(dirs[FIELDS[asked[0]]] + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
// `cli`: la línea de comandos como función, para el aplicador (scripts/setup/applier-batch.js)
module.exports = { resolveSkillsDirs, resolveInstalledSkillsDirs, cli: main };
