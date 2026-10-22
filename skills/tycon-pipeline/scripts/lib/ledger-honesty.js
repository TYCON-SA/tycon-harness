'use strict';
/**
 * ledger-honesty.js — que el pipeline sepa CUÁNDO no sabe qué cambió.
 *
 * EL PROBLEMA. El re-loop de advisors decide a quién
 * re-correr comparando el estado actual contra una foto (`filesSnapshot`). Las tres fuentes
 * del delta salen, todas, del mismo lugar: `marker.filesTouched` / `marker.fileEvents`, que
 * escribe `on-edit.js` desde el hook PostToolUse matcher `Edit|Write`. Incluida la que se usa
 * como red para "ediciones hechas por Bash": el fallback por mtime **itera sobre
 * `filesTouched`**, así que sólo cubre un archivo que el hook YA vio y se re-editó por fuera —
 * NO un archivo que el hook no vio nunca.
 *
 * Ejemplo: el registro de la sesión puede tener 7 entradas y las 7 ser
 * scratchpad de los probes del pase adversarial. Cero ediciones del repo — ni PluginManager,
 * ni EndpointRegistrar, ni los tests. `smart-reloop` devuelve un delta chico y **nadie avisa que
 * está ciego**: un archivo con contenido no despierta la sospecha de "esto no se está
 * escribiendo". Es más difícil de ver que un registro vacío, porque el registro tiene ruido.
 *
 * LO QUE HACE ESTE MÓDULO. Dos cosas, las dos puras (sin fs, sin git — los insumos los junta el
 * llamador, así que esto se testea sin sandbox):
 *
 *   1. `esProbe` / `sinProbes` — los archivos de prueba descartables del pase adversarial no son
 *      trabajo del repo. Ensucian dos cosas a la vez: hacen parecer sano un registro que está
 *      ciego, y se cuelan en el `filesSnapshot` del pipeline. Convención de nombres reservados en
 *      `steps/step-08-adversarial-pass.md`.
 *
 *   2. `diagnosticar` — la pregunta honesta: ¿el registro vio algo del repo? Si git reporta N
 *      archivos cambiados y el registro aporta CERO, el delta no es "chico": es **ciego**, y el
 *      modo correcto es el set completo ANUNCIADO CON LA RAZÓN. Sin el diagnóstico el orquestador llega igual
 *      al set completo, pero a ciegas y más tarde, sin saber por qué.
 *
 * Por qué no alcanzaba con leer `suspect_empty_delta`: ya existe y es un campo que alguien tiene
 * que mirar. Mirarlo es justo lo que no pasa.
 */

const path = require('path');

/**
 * Nombres reservados para los probes transitorios del pase adversarial (step-05b).
 * Cubre los nombres que se ven en los repos + la convención que el step declara para lo que venga:
 *   .NET      ZZProbe*.cs · ZZVerify*.cs
 *   JS/TS     __probe*.test.ts · _probe_*.test.ts · __adv_probe*.test.ts · __adversarial_probe*
 * Ancla al principio del nombre de archivo a propósito: un test legítimo no empieza con `_` ni
 * con `zzprobe`, y un patrón suelto que matchee en el medio se comería trabajo real.
 */
// 🔴 Acotado: un patrón que matchee cualquier nombre que empiece con `_adv` o `__adv` se come
// archivos REALES muy comunes — `_advanced.scss`
// (partial de Sass), `__advisor.ts`, `_adapter.js` (módulo privado). Un falso positivo acá no es
// cosmético: saca un archivo de trabajo real de la foto de la iteración, y el advisor que tiene que
// re-auditarlo no se entera. Por eso se exige la palabra `probe` COMPLETA (con `adv`/`adversarial`
// como prefijo opcional), que es lo que la convención del step-05b declara.
const PROBE_RE = /^(?:zz(?:probe|verify)|_{1,2}(?:adv|adversarial)?_?probe(?:[_.\d]|$))/i;
// El prefijo `zz` va sin terminador a propósito: ningún archivo real empieza con `zzprobe`/
// `zzverify` (por eso la convención eligió ese prefijo). El que necesita terminador es el de
// guión bajo, que sí colisiona con nombres reales.

/** ¿Es un probe transitorio del pase adversarial? Decide por el NOMBRE del archivo. */
function esProbe(p) {
  if (!p) return false;
  return PROBE_RE.test(path.basename(String(p).replace(/\\/g, '/')));
}

/** Saca los probes de una lista de paths. Devuelve array nuevo. */
function sinProbes(files) {
  return (Array.isArray(files) ? files : []).filter((f) => !esProbe(f));
}

/** ¿El path cae DENTRO del repo bajo revisión? Un scratchpad en /tmp no es trabajo del repo. */
function esDelRepo(p, repoPath) {
  if (!p || !repoPath) return false;
  // 🔴 Resolver ANTES de comparar: con los strings crudos,
  // un `--repo` escrito relativo (`.`, `./MiRepo`) o con `..` en el medio no matchea
  // NINGUNA entrada del registro → todo registro se declara ciego → force-full en cada iteración
  // y una línea `blind` falsa en gates.log. El diagnóstico de ceguera tiene que ser difícil de
  // disparar por accidente: un falso ciego cuesta el set completo, que es el camino más caro.
  // realpath primero (macOS: /tmp y os.tmpdir() son symlinks a /private/...), path.resolve como
  // respaldo si el archivo ya no existe — un archivo borrado sigue siendo "del repo".
  const norm = (x) => {
    const crudo = String(x);
    try { return require('fs').realpathSync(crudo).replace(/\\/g, '/').replace(/\/+$/, ''); }
    catch { /* no existe o no se puede resolver → seguimos con resolve */ }
    try { return path.resolve(crudo).replace(/\\/g, '/').replace(/\/+$/, ''); }
    catch { return crudo.replace(/\\/g, '/').replace(/\/+$/, ''); }
  };
  const f = norm(p);
  const r = norm(repoPath);
  return f === r || f.startsWith(`${r}/`);
}

/**
 * ¿El registro de ediciones ve lo que ve git?
 *
 * @param {object} p
 * @param {string} p.repoPath          raíz del repo bajo revisión
 * @param {string[]} p.registro        paths que aporta el marker (filesTouched ∪ fileEvents)
 * @param {string[]} p.gitCambiados    paths que git ve modificados/nuevos en el working tree
 * @returns {{ciego: boolean, razon: string|null, registroUtil: string[], gitUtil: string[],
 *            probesDescartados: string[], fueraDelRepo: string[]}}
 */
function diagnosticar({ repoPath, registro, gitCambiados }) {
  const reg = [...new Set(Array.isArray(registro) ? registro.filter(Boolean) : [])];
  const git = [...new Set(Array.isArray(gitCambiados) ? gitCambiados.filter(Boolean) : [])];

  const fueraDelRepo = reg.filter((f) => !esDelRepo(f, repoPath));
  const dentro = reg.filter((f) => esDelRepo(f, repoPath));
  const probesDescartados = dentro.filter(esProbe);
  const registroUtil = dentro.filter((f) => !esProbe(f));
  const gitUtil = sinProbes(git);

  // Ciego = git ve trabajo del repo y el registro no aporta NADA de ese repo. Que el registro
  // tenga entradas no lo salva: 7 líneas de scratchpad son 7 líneas de ruido.
  const ciego = gitUtil.length > 0 && registroUtil.length === 0 && !registroNoAplica(repoPath);
  if (!ciego) {
    return {
      ciego: false, razon: null, registroUtil, gitUtil, probesDescartados, fueraDelRepo,
      ...(registroNoAplica(repoPath) ? { registro_no_aplica: true } : {}),
    };
  }

  const partes = [];
  if (fueraDelRepo.length) partes.push(`${fueraDelRepo.length} fuera del repo (scratchpad)`);
  if (probesDescartados.length) partes.push(`${probesDescartados.length} probes del pase adversarial`);
  const detalleRegistro = reg.length === 0
    ? 'el registro está VACÍO'
    : `el registro tiene ${reg.length} entrada(s) pero ninguna es trabajo del repo (${partes.join(' · ')})`;

  return {
    ciego: true,
    razon:
      `registro de ediciones CIEGO: git ve ${gitUtil.length} archivo(s) cambiado(s) en el repo y ` +
      `${detalleRegistro}. El delta no es "chico", es ciego → set COMPLETO. ` +
      'Causa típica: las ediciones no pasaron por las tools Edit/Write (el hook que alimenta el ' +
      'registro es PostToolUse matcher Edit|Write, así que una edición hecha con Bash —sed, heredoc— ' +
      'es invisible por construcción).',
    registroUtil,
    gitUtil,
    probesDescartados,
    fueraDelRepo,
  };
}

/**
 * ¿Este repo está FUERA del alcance del registro de ediciones, por diseño?
 *
 * `on-edit.js` descarta explícitamente todo path bajo `~/.claude` (para no registrar como "trabajo
 * del repo" las ediciones al propio arnés). Consecuencia: en un repo que VIVE ahí —`agent-skills`
 * es el caso— el registro está vacío SIEMPRE, y sin este chequeo el diagnóstico lo declararía ciego
 * en cada iteración de cada corrida → force-full permanente sobre el repo que más se toca.
 *
 * No es "no sé": es "acá el registro no aplica", y por eso no se acusa.
 */
function registroNoAplica(repoPath) {
  if (!repoPath) return false;
  try {
    const home = require('os').homedir();
    return esDelRepo(repoPath, path.join(home, '.claude'));
  } catch { return false; }
}

module.exports = { esProbe, sinProbes, esDelRepo, diagnosticar, registroNoAplica, PROBE_RE };
