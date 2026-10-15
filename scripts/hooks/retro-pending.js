#!/usr/bin/env node
'use strict';
// retro-pending.js — "push a main sin retrospectiva" (2026-08-24, incident-log#retro-multi-repo-2026-08-24)
//
// POR QUÉ EXISTE: el único disparador del tycon-retrospective-capturer era el step 10b de
// /tycon-merge-to-main — un paso al FINAL del skill que depende de que el agente se acuerde. Falló
// de dos formas medidas: (1) merges a main fuera del skill, sin rastro; (2) sesiones que mergean
// 2+ repos y lanzan el capturer para uno solo (2026-08-24: FrontEnd sí, BackEnd no — "docs-only,
// no hace falta", decisión del agente). El aviso de staleness sólo grita a los 7 días.
//
// QUÉ HACE (un script, tres eventos — el modo se deduce del payload o se fuerza con --mode):
//   record (PostToolUse Bash): un `git push` que toca main/master en un repo bajo el arnés deja
//           constancia en ~/.claude/.tycon-pipeline/retro-pending.jsonl {ts, sessionId, repoPath, sha}.
//   gate   (Stop): cada merge anotado tiene que tener SU ARCHIVO de métricas (repo + merge_commit, el
//           mismo criterio de «cubierto» que el aviso) → si alguno no lo tiene, bloquea el cierre del
//           turno con el comando del latido (scripts/metrics/retro-heartbeat.js, un segundo, sin modelo).
//           Reclama los merges de ESTA sesión y también los de OTRA sesión que estén en el
//           repo/workspace del cwd y ya tengan cierta antigüedad (TYCON_RETRO_GATE_FOREIGN_MIN_AGE_MIN,
//           30 min) — sin eso, un merge que la sesión dueña no cerró sólo lo reclamaba el aviso de
//           arranque, que se puede ignorar (medido: 4 días). Los ajenos se agrupan por repo. Tope 3
//           bloqueos seguidos (después deja pasar avisando).
//   notice (SessionStart): lista los merges anotados que NINGUNA retrospectiva cubrió todavía,
//           con el comando para lanzarla — pero SOLO los del repo/workspace de la sesión (el cwd).
//           Los pendientes de OTROS proyectos se resumen en una línea informativa SIN instrucción
//           de lanzamiento: se reclaman al abrir sesión en su propio repo (feedback del dev
//           2026-08-28: una sesión de un producto lanzó las retrospectivas de otros productos del equipo — el
//           aviso global convertía cualquier sesión en la mula de carga de todos los proyectos — guides/incident-log.md#case-retro-launched-for-other-repos-2026-08-28).
//           Escape hatch: TYCON_RETRO_PENDING_SCOPE=all restaura el listado global con instrucción.
//           El backstop de "nadie abre sesión en ese repo" sigue siendo retro-staleness-notice.js.
// LÍMITES DECLARADOS de la atribución (pase adversarial 2026-09-15, hallazgos #4 a #6). No están
// arreglados a propósito: los tres viven en el regex del `cd` de la lib COMPARTIDA con
// session-collision-guard.js, y tocarlo cambia lo que ese freno BLOQUEA — otra pieza, otra medición
// y otros casos. Los tres caen en la conducta de siempre (atribuir al repo de la sesión), que para
// el freno es su lado seguro y acá es una entrada contra el repo equivocado: la misma forma del
// incidente del 15-09, con una cola.
//   · `cd X 2>/dev/null && git push origin main` — el regex del `cd` exige que la sentencia termine
//     en el argumento, así que la redirección lo esconde y el `cd` no se sigue.
//   · `pushd X && git push origin main && popd` — `pushd` no se entiende como un cambio de
//     directorio (tampoco `popd`).
//   · `cd $HOME/X && …` — `HOME` se trata como una variable que el comando no define (`~` sí se
//     expande), así que sale "no pude resolver": no anota nada y lo dice. Ruidoso, no falso.
// Y lo que NO se ve, por el mismo precio que ya se pagaba: un push dentro de un `sh -c "…"` o de un
// heredoc que no alimenta a un shell (`python3 - <<EOF` que lanza el push por dentro). Desde el
// 2026-09-17 ese cuerpo se quita ANTES de analizar —es texto, no comandos: un `node - <<EOF` con un
// string con forma de push disparaba el aviso de "no pude resolver" sin que hubiera ningún push—; el
// de un `bash <<EOF` se conserva y su push se sigue anotando. Lo demás lo cubre
// retro-staleness-notice.js, por días.
// "Cubierto" es MECÁNICO: el capturer escribe en ~/.claude/tycon-harness/.dashboard/metrics-*.json
// `repo` + `merge_commit`; una entry pendiente se da por cubierta cuando existe un JSON con ese repo
// y ese commit (prefijo). Límite honesto: un push hecho desde una terminal sin Claude/Codex no pasa
// por este hook — ese caso lo sigue cubriendo retro-staleness-notice.js (por días).
// 🔴 EL BUCLE DE LA RETRO (2026-09-16, cierre de la story 2.6): la retrospectiva escribe sus
// conclusiones en archivos (.dashboard/metrics-*.json, guides/guide-update-proposals.md) que también
// hay que subir a main — y ese push volvía a exigir OTRA retrospectiva, que escribía, que había que
// subir. Se cortó a mano lanzando una segunda retro instruida a no escribir nada. Dos arreglos:
//   · Un push cuyos commits nuevos son TODOS salida de una retrospectiva no pide otra. Criterio
//     ANGOSTO a propósito: se lee el rango origin/<main>@{1}..origin/<main> —el reflog del
//     remote-tracking ref, que el propio push acaba de mover— y TODOS los mensajes tienen que
//     empezar con `chore(retro` (así se titulan los commits de salida de la retro; medido: los 5
//     reales de este repo). Basta UNO que no lo sea para registrar como siempre: este hook existe
//     porque un agente decidió que un cambio «sólo de docs» no necesitaba retro — eximir «todo push
//     sin merge» reabriría ese agujero, y en el repo del arnés casi todo va directo a main sin
//     merge. Si no se puede saber qué trajo el push (sin `origin/<main>`, reflog apagado, rango
//     vacío o ilegible) se registra: la duda va hacia más control, nunca hacia menos. Un clon
//     fresco SÍ se resuelve: cada entrada del reflog guarda el valor viejo, así que tras el primer
//     push `@{1}` es donde estaba el remoto (medido 2026-09-16). Límites declarados: es una convención de
//     mensaje (un commit titulado `chore(retro` a mano la esquiva — el mismo precio que `[skip ci]`)
//     y no aplica al modo PR (ahí el merge lo hace ADO y acá no hay rango que leer).
//   · "Cubierto" mira también el .dashboard/ del REPO DEL PUSH (entry.repoPath), no sólo el del
//     checkout donde vive el hook: una retro corrida desde un clon descartable deja su métrica en el
//     .dashboard/ DEL CLON, y el control no la veía hasta que el checkout compartido bajara main.
// 🔴 LA RETRO QUE NO APORTA NADA (2026-09-16, incident-log#retro-por-push-sin-story-2026-09-16): un fix
// de 18 líneas en un test (main 525a4b0) produjo una retrospectiva completa —~5 min de agente y un commit
// `chore(retro` más— con 5 de sus 8 métricas en null «sin story»: las métricas son del pipeline de una
// story, y un push ad-hoc no tiene pipeline. Medido ANTES de tocar (30 días, 20 repos, línea de main):
// 1812 commits, 346 tocaron SÓLO tests/docs/.dashboard/.engram sin cerrar story (285 en el arnés,
// que va directo a main); 119 retrospectivas, 82 sin story, 25 con la mitad o más de sus métricas en null.
// Exención MECÁNICA por los ARCHIVOS del push (nunca por el texto del mensaje: una etiqueta se esquiva):
// exento si TODO lo que trajo el push vive bajo un directorio `tests/` o `__tests__/`, es `.md`, o está en
// `.dashboard/` o `.engram/` — y NUNCA si el push cierra una story: trae algo bajo `.advisors/` (evidencia
// de pipeline-runs / dod-runtime) o cambia un `status:` en un `.md`. Un push cuyos commits son todos
// `chore(retro` sigue exento como antes (sin entrada). La exención DEJA CONSTANCIA: entrada en el ledger
// con `exento: 'solo-tests-docs'` y los archivos que la justifican; el gate no la reclama, y el aviso de
// arranque CUENTA exentos vs con retro (`--report` para el detalle) — una exención que no se cuenta es un
// apagado silencioso. Sin rango legible (sin reflog, modo PR, rango vacío, `git` que falló) NO hay exención:
// la duda va hacia más control. Límites declarados: un `foo.test.js` suelto fuera de `tests/` no exime
// (hacia más control) y un `status:` dentro de un bloque de código de un `.md` tampoco. Casos:
// 14-retro-pending.json (`exento-…`, `registra-push-MIXTO-test-mas-js…`, `registra-push-que-cierra-story…`).
// La regla dura no se toca: un merge de story pide su retrospectiva, por repo, siempre.
// 🔴 EL RECORTE: EXIGE EL ARCHIVO, NO EL AGENTE (2026-09-16, story 7.1,
// incident-log#retro-sin-modelo-2026-09-16). El gate emparejaba cada merge con un
// tycon-retrospective-capturer LANZADO (spawns del ledger advisor-runs/, por sha, por repo o comodín).
// Medido en 30 días: 87 lanzamientos con duración y tokens, 4,9 min y 135 k tokens de mediana —
// 8,3 h y 12,5 M tokens—, 119 archivos de métricas de los que 63 no tenían story (18 lanzados sólo
// para que este freno dejara de reclamar), y de las seis métricas del contrato cuatro ya las publican
// otras piezas (2.9, 2.14, 2.15). Aguas abajo el archivo tiene dos consumidores: `first_pass_ratio`
// del nocturno SDLC y este mismo hook. Así que el paso 10b ya no lanza el agente: corre
// retro-heartbeat.js, que escribe el archivo en un segundo; el agente queda a pedido («retro con
// modelo»). Y el gate dejó de mirar spawns: UN AGENTE LANZADO YA NO PAGA LA DEUDA, LA PAGA EL
// ARCHIVO — si el agente no lo escribió, bloquea igual. Salieron `capturerSpawns`, `unmatched`,
// `foreignUnclaimed`, `spawnRepo`, `shaMatch` y la pista de «retros lanzadas que no quedaron
// registradas»; el ledger advisor-runs/ ya no es insumo de este hook (on-advisor-run.js sigue
// escribiendo retro_repo/retro_sha: no se tocó, no se lee). La lección de retro-multi-repo sigue en
// pie para la llamada al script: lo que importa se exige al cerrar, no se recuerda.
// 🔴 QUIÉN ES EL ARNÉS: LO DICE EL REMOTO, NO LA CARPETA (2026-09-17, el pendiente (a) de
// incident-log#retro-por-push-sin-story-2026-09-16). Los repos del arnés no deben retrospectiva, y
// eso se decidía mirando si algún segmento de la RUTA se llamaba `agent-skills` o
// el arnés. O sea que el mismo push se registraba o no según desde qué carpeta se
// hacía: un clon descartable del arnés (`…/scratchpad/tcg`, que es como se trabaja cuando hay otra
// sesión viva en el checkout) SÍ quedaba anotado, y un repo de producto clonado debajo de una
// carpeta con ese nombre quedaba excluido sin serlo — la segunda es la cara: una retrospectiva que
// no se pide y nada lo dice. Ahora decide el `origin` del repo del push, comparado como
// (org, proyecto, repo) de Azure en cualquiera de sus formas de URL (dev.azure.com,
// *.visualstudio.com, ssh; con cualquier usuario adelante). Un `origin` que es una ruta local —el
// clon de un checkout— se sigue hasta el repo de verdad, con tope de saltos. El nombre de la carpeta
// queda SÓLO como respaldo para el repo que no tiene `origin` (no hay otra identidad que leer). Un
// remoto que no se sabe leer no es el arnés: se registra. La política no cambió: los repos del arnés
// siguen excluidos. Límites declarados: mira `origin` aunque el push nombre otro remoto (igual que
// el resto del hook, que lee `origin/<main>`), y las dos identidades están escritas en la lib — si
// un repo del arnés se muda de proyecto en Azure, este hook empieza a registrarlo (ruidoso, no mudo).
// El criterio vive en UN lugar, scripts/lib/harness-repo.js: la misma exclusión estaba escrita
// tres veces (acá, en unpushed-work-notice.js y en lib/story-gate.js de agent-skills), las tres por
// carpeta. Casos: 14-retro-pending.json (`quiet-clon-del-arnes-…`,
// `registra-repo-de-producto-debajo-…`) y scripts/tests/harness-repo.test.sh.
// 🔴 LOS REPOS DE LABORATORIO (2026-10-14). Una sesión armó un repo de juguete en su carpeta de trabajo temporal
// (`/private/tmp/…/scratchpad/…`, con `.tycon/` y `origin` a un repo de PRUEBA en GitHub) para probar una story, empujó
// tres veces a main, y el cierre del turno quedó frenado por tres «merges sin retrospectiva» que ninguna retrospectiva
// tenía sentido escribir. Ahora un push a main desde un repo de laboratorio NO se anota, y SE DICE (stderr, exit 2,
// con el comando del latido por si era de verdad); el freno y el aviso de arranque tampoco reclaman las entradas viejas
// de un repo que sigue en pie y es de laboratorio. Un repo es de laboratorio si cumple LAS DOS:
//   1. vive en una carpeta temporal: la del sistema (`os.tmpdir()`, TMPDIR/TEMP/TMP) o las de siempre de un Unix
//      (`/tmp`, `/var/tmp`, `/var/folders`, y sus `/private/…` en Mac) — ahí van también las carpetas de trabajo de las
//      sesiones. Nunca el HOME ni algo que lo contenga, aunque una variable lo nombre. `TYCON_RETRO_LAB_DIRS` (carpetas
//      separadas por el separador de rutas del sistema) REEMPLAZA esa lista; puesta y vacía, no hay ninguna (las suites
//      que arman sus repos en el temporal la usan para medirlos como repos de verdad);
//   2. y su `origin` no lleva a un repo de verdad: no tiene `origin`; o lo tiene, pero ninguna copia de trabajo
//      FUERA de las carpetas temporales, bajo la raíz de repos (scripts/lib/repos-root.js), tiene ese mismo remoto.
// Lo que NO es laboratorio aunque viva en el temporal — el cuidado de la regla: el clon descartable de un repo de
// verdad. Si su `origin` es una ruta, se sigue (harness-repo.js) y basta que la cadena salga de las temporales; si es
// un remoto, basta que haya una copia de trabajo de ese mismo remoto bajo la raíz de repos. Y la duda va hacia más
// control: sin raíz de repos, sin repos-root.js al lado (una copia suelta de este archivo), con un remoto que no se
// sabe leer o con una cadena de clones que pasa el tope, se anota como siempre. Límites declarados: un repo de verdad
// que sólo existe en el temporal (sin copia de trabajo afuera) cuenta como laboratorio, y por eso se dice en cada push;
// la cuenta de `--report` no separa las entradas viejas de laboratorio. Casos: 14-retro-pending.json
// (`quiet-…-laboratorio…`, `registra-clon-descartable-…`, `deja-parar-…-laboratorio`).
// Off: TYCON_RETRO_PENDING=0. Fail-open total: nunca rompe un push, un stop ni un arranque.
const fs = require('fs');
const os = require('os');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: este
// archivo viaja suelto (al banco, a laboratorios de pruebas); ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const { execFileSync } = require('child_process');
// Lector COMPARTIDO de `az repos pr` (AZ-PR-PARSER-UNICO-1, 2026-09-06): el regex propio sólo
// entendía `--target-branch main`; con la forma corta `-t main` un merge por PR no se registraba y
// no había retrospectiva — en silencio. Copiado al sandbox del banco junto con el hook (setups).
const az = require(path.join(__dirname, '..', 'lib', 'az-pr.js'));
// Resolutor COMPARTIDO de "a qué repo apunta este git" (RETRO-PENDING-CD-MISATTR-1, 2026-09-15).
// El repo se calculaba con el cwd de la SESIÓN, sin seguir el `cd` ni el `-C` del propio comando.
// Caso real del 2026-09-15: `cd ~/.claude/agent-skills && git push origin main` quedó anotado
// contra un repo del equipo con la sha `2f6a0fcbe459` — el `origin/main` STALE de ese otro checkout.
// Y como el repo estaba mal, la exclusión de los repos del arnés (unas líneas más abajo) nunca se
// activó: quedó un pendiente que ninguna retrospectiva podía cerrar, reclamado en cada sesión de
// un repo del equipo para siempre. El criterio ya existía en session-collision-guard.js ("el repo DESTINO
// del comando, no el de la sesión"); se extrajo a scripts/lib/git-target.js en vez de escribirlo
// por tercera vez. Casos: 14-retro-pending.json (los cinco últimos de "registra").
const destinoGit = require(path.join(__dirname, '..', 'lib', 'git-target.js'));
const GIT_PUSH = destinoGit.regexDeGit(destinoGit.VERBOS_QUE_PUBLICAN);
// Quién es un repo DEL arnés (2026-09-17): lo dice el remoto `origin`, no la carpeta. Criterio ÚNICO,
// compartido con unpushed-work-notice.js y con el portón de carril de agent-skills — estaba escrito
// tres veces, las tres por nombre de carpeta. Copiado al sandbox del banco junto con el hook (setups).
const { esRepoDelArnes, juzgarRepo, identidadRemoto, resolverRemoto, mismaIdentidad } = require(path.join(__dirname, '..', 'lib', 'harness-repo.js'));
// El cuerpo de un heredoc que NO va a un shell es TEXTO, no comandos (2026-09-17). Caso real de ese
// día: un `node - <<'EOF'` cuyo cuerpo traía, dentro de un string, `cd ${dir} && … && git push -q origin
// main`. El recorrido por sentencias corta por `&&` sin mirar dónde está, así que vio un `cd` a una
// variable que nadie define seguido de un `git push … main`: aviso de «no pude resolver a qué repo fue
// ese push» + exit 2, sin que hubiera ningún push. Los heredocs que sólo MENCIONAN un push ya callaban
// (`mencion`), pero sólo porque su texto no EMPEZABA una sentencia con `git`; éste sí. Ahora el cuerpo
// se quita antes de analizar — salvo cuando el heredoc alimenta a un shell (`bash <<EOF`,
// `cat <<EOF | sh`): ahí el cuerpo SON comandos y un push de verdad se sigue viendo como hasta hoy.
const { sinHeredocs } = require(path.join(__dirname, '..', 'lib', 'shell-parse.js'));

/** El comando con lo que está ENTRE COMILLAS tapado (mismo largo, para no mover nada de lugar).
 *  Distingue un git de verdad de un git MENCIONADO: `grep -rn "git push origin main" docs/` habla
 *  de un push, no lo hace. */
function sinLoCitado(texto) {
  return String(texto).replace(/"[^"]*"|'[^']*'/g, (m) => ' '.repeat(m.length));
}

const STATE_DIR = path.join(stateDirOf(os.homedir()));
const LEDGER = path.join(STATE_DIR, 'retro-pending.jsonl');
// de qué árbol se leen los .dashboard que escribe el nocturno (story 8.23, A2, AC 6): lo decide tycon-home.js (hoy, este
// mismo árbol; desde la B, el clon que se mantiene); si este archivo viaja suelto, este árbol
const MAINTAINED_TREE = (() => {
  const own = path.resolve(__dirname, '..', '..');
  const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js');
  return fs.existsSync(lib) ? require(lib).maintainedDir(os.homedir(), own) : own;
})();
const DASHBOARD_DIR = MAINTAINED_TREE ? path.join(MAINTAINED_TREE, '.dashboard') : null;
// y donde escribe el latido en esta máquina según tycon-home.js (story 8.23, tanda D): en una instalación bajada sin clon
// declarado es ~/.tycon/state/dashboard — si no se mira ahí, el latido que este aviso pide correr nunca lo apaga
const MACHINE_DASHBOARD_DIR = (() => {
  // desde la story 8.26 (tanda J) el latido escribe donde dice scripts/lib/night-data.js: en una versión bajada, el clon de
  // mantenimiento que la máquina declara (nunca el del público). Sin esa biblioteca al lado, lo de antes.
  // (si la biblioteca ESTÁ y no carga, tira: no se vuelve callado a la ruta de antes; si no pudo saber, lo avisa ella)
  { const lib = path.join(__dirname, '..', 'lib', 'night-data.js'); if (fs.existsSync(lib)) { const d = require(lib).machineDashboardDir(path.resolve(__dirname, '..', '..')); if (d) return d; } }
  try { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); const TH = require(lib); return typeof TH.dashboardDir === 'function' ? TH.dashboardDir(os.homedir(), MAINTAINED_TREE || path.resolve(__dirname, '..', '..')) : null; } catch { return null; }
})();
const MAX_BLOCKS = 3;
const LATIDO = path.resolve(__dirname, '..', 'metrics', 'retro-heartbeat.js');

function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
// Memo por proceso (2026-09-18): el aviso de arranque resolvía las mismas rutas cientos de veces
// (cada entrada del ledger × cada metrics-*.json con `repo` absoluto). Una corrida del hook es corta
// y no crea ni mueve directorios entre dos llamadas, así que la respuesta no cambia adentro de ella.
const realMemo = new Map();
function real(p) {
  const k = String(p);
  if (realMemo.has(k)) return realMemo.get(k);
  let r;
  try { r = fs.realpathSync(p); } catch { r = k; }
  realMemo.set(k, r);
  return r;
}
function sessionIdOf(event) {
  return event.session_id || process.env.CLAUDE_CODE_SESSION_ID || process.env.TYCON_SESSION_ID || process.env.CODEX_SESSION_ID || '_nosession';
}
function git(cwd, args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim(); }
  catch { return ''; }
}
// Igual que `git`, pero "falló" es null y no '' — para las preguntas donde un vacío significa "exento"
// y un fallo tiene que significar "no sé" (o sea, registrar): un `git log` que revienta por tamaño o por
// tiempo no puede leerse como "no cambió ningún status".
function gitOrNull(cwd, args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 16 * 1024 * 1024 }).trim(); }
  catch { return null; }
}

// ── cubierto por una retrospectiva? (metrics-*.json con repo + merge_commit) ─────────────────────
// Se mira en DOS lugares (2026-09-16, ver "EL BUCLE" en la cabecera): el .dashboard/ del checkout
// donde vive el hook (el arnés canónico, donde el capturer escribe por contrato) Y el .dashboard/
// del repo del push. Una retro corrida desde un clon descartable del arnés deja su metrics-*.json
// en el clon, y hasta que el checkout compartido bajara main el control decía "sin retrospectiva"
// sobre un merge que ya la tenía — y bloqueaba el cierre del turno por eso.
function dashboardsDe(entry) {
  const out = [];
  for (const d of [DASHBOARD_DIR, MACHINE_DASHBOARD_DIR, path.join(String(entry.repoPath || ''), '.dashboard')].filter(Boolean)) {
    const r = real(d);
    if (!out.includes(r)) out.push(r);
  }
  return out;
}
// Cada .dashboard/ se lee y se parsea UNA vez por proceso (2026-09-18): se releían los ~190
// metrics-*.json (5 MB) por CADA entrada del ledger, dos veces en el arranque (pendientes + cuenta de
// la ventana) — 12 a 17 s de aviso, creciendo con entradas × archivos. El criterio de «cubierto» no
// cambió: la misma lectura de campos, en el mismo orden, sólo que memorizada. null = directorio
// ilegible (se saltea, como antes).
const metricasMemo = new Map();
function metricasDe(dir) {
  if (metricasMemo.has(dir)) return metricasMemo.get(dir);
  let lista = null;
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    lista = [];
    for (const f of files) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      // Un archivo que es `null` hacía reventar la lectura de campos (y el fail-open global callaba el
      // aviso). Se conserva tal cual —cambio de rendimiento, no de conducta—: revienta al llegar a él.
      if (d === null) { lista.push({ roto: true }); continue; }
      const repo = d.repo || d.repo_path || d.repoPath;
      const sha = String(d.merge_commit || d.mergeCommit || d.commit || '');
      if (!repo || !sha) continue;
      lista.push({ repoStr: String(repo), sha });
    }
  } catch { lista = null; }
  metricasMemo.set(dir, lista);
  return lista;
}
function coveredByMetrics(entry) {
  const repoReal = real(entry.repoPath);
  const repoRealBarras = repoReal.replace(/\\/g, '/');
  for (const dir of dashboardsDe(entry)) {
    const lista = metricasDe(dir);
    if (!lista) continue;
    for (const m of lista) {
      if (m.roto) throw new TypeError(`metrics null en ${dir}`);
      const { repoStr, sha } = m;
      // El contrato pide `repo` ABSOLUTO, pero capturers viejos escribieron paths relativos
      // ("Lapacho/Backend") — se aceptan por sufijo con corte en separador (medido 2026-08-28:
      // sin esto, retros reales quedaban invisibles y el pendiente se reclamaba para siempre).
      const matchesRepo = path.isAbsolute(repoStr)
        ? real(repoStr) === repoReal
        // Separadores normalizados a "/" en los dos lados: un `repo` relativo escrito con "/" nunca
        // matcheaba contra `path.sep` en Windows → la cobertura por metrics quedaba invisible y el
        // pendiente se reclamaba para siempre (pase adversarial 2026-08-31).
        : repoRealBarras.endsWith('/' + repoStr.replace(/[\\/]+$/, '').replace(/\\/g, '/'));
      if (!matchesRepo) continue;
      if (sha.startsWith(entry.sha) || String(entry.sha).startsWith(sha)) return true;
    }
  }
  return false;
}
function pendingEntries() {
  const seen = new Set();
  const out = [];
  for (const e of readJsonl(LEDGER)) {
    if (!e || !e.repoPath || !e.sha) continue;
    // Exento (sólo tests/docs): contado, nunca reclamado — ni por el gate ni por el aviso.
    if (e.exento) continue;
    const key = `${real(e.repoPath)}@${e.sha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (coveredByMetrics(e)) continue;
    // Una entrada vieja de un repo de laboratorio que sigue en pie no se reclama (cabecera). Si la carpeta ya no está,
    // no se puede juzgar: se reclama como siempre.
    if (fs.existsSync(e.repoPath) && juzgarLaboratorio(e.repoPath).laboratorio) continue;
    out.push(e);
  }
  return out;
}
// Lo que el ledger dice de los últimos `dias` días: cuántos pushes tuvieron su retrospectiva, cuántos
// quedaron exentos y cuántos siguen sin ella. Es el número que hace visible la exención.
function contarVentana(dias) {
  const desde = Date.now() - dias * 86400000;
  const seen = new Set();
  const c = { dias, conRetro: 0, exentos: 0, pendientes: 0, exentas: [] };
  for (const e of readJsonl(LEDGER)) {
    if (!e || !e.repoPath || !e.sha) continue;
    const t = Date.parse(e.ts);
    if (!t || t < desde) continue;
    const key = `${real(e.repoPath)}@${e.sha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.exento) { c.exentos++; c.exentas.push({ repo: e.repoPath, sha: e.sha, ts: e.ts, exento: e.exento, archivos: e.archivos || [] }); }
    else if (coveredByMetrics(e)) c.conRetro++;
    else c.pendientes++;
  }
  return c;
}
// El comando que paga la deuda: el latido (story 7.1). Lo usan el gate y el aviso de arranque.
function launchHint(e) {
  return `node "${LATIDO}" --repo "${e.repoPath}" --merge ${e.sha} [--story <id> si el merge cierra una story]`;
}

// ── ¿repo de laboratorio? (2026-10-14, «LOS REPOS DE LABORATORIO» en la cabecera) ──────────────
const ENV_LAB_DIRS = 'TYCON_RETRO_LAB_DIRS';
const CENSO_PROFUNDIDAD = 4;          // ~/repos/Producto/Backend/src: alcanza para las copias de trabajo del equipo
const CENSO_TOPE = 4000;              // carpetas miradas como mucho: la raíz de repos de una máquina no se recorre entera
const CENSO_SALTEA = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', 'vendor', 'packages']);
// En Mac y Windows el disco no distingue mayúsculas: `/TMP/x` y `/tmp/x` son la misma carpeta.
const caja = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? String(p).toLowerCase() : String(p));
let temporalesMemo = null;
function carpetasTemporales() {
  if (temporalesMemo) return temporalesMemo;
  const declaradas = process.env[ENV_LAB_DIRS];
  const crudas = declaradas !== undefined
    ? String(declaradas).split(path.delimiter)
    : [os.tmpdir(), process.env.TMPDIR, process.env.TEMP, process.env.TMP,
      ...(process.platform === 'win32' ? [] : ['/tmp', '/var/tmp', '/var/folders', '/private/tmp', '/private/var/tmp', '/private/var/folders'])];
  const casa = caja(real(os.homedir()));
  const out = [];
  for (const c of crudas) {
    const t = String(c || '').trim();
    if (!t || !path.isAbsolute(t) || !fs.existsSync(t)) continue;
    const r = real(t);
    // nunca el HOME ni algo que lo contenga (`/`, `/Users`): una variable mal puesta volvería laboratorio a todo
    if (underOrEqual(casa, caja(r))) continue;
    if (!out.includes(r)) out.push(r);
  }
  return (temporalesMemo = out);
}
function enTemporal(p) {
  const r = caja(real(p));
  return carpetasTemporales().some((t) => underOrEqual(r, caja(t)));
}
/** El `origin` de una copia de trabajo, leído de su .git/config (sin lanzar git: el censo mira decenas). */
function origenDeCopia(dir) {
  const dotgit = path.join(dir, '.git');
  let st;
  try { st = fs.statSync(dotgit); } catch { return null; }
  if (!st.isDirectory()) return git(dir, ['remote', 'get-url', 'origin']) || null;   // un worktree o un submódulo
  let texto = '';
  try { texto = fs.readFileSync(path.join(dotgit, 'config'), 'utf8'); } catch { return null; }
  let enOrigin = false;
  for (const linea of texto.split(/\r?\n/)) {
    const sec = linea.match(/^\s*\[\s*([^\]]+?)\s*\]/);
    if (sec) { enOrigin = /^remote\s+"origin"$/.test(sec[1]); continue; }
    const m = enOrigin && linea.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (m) return m[1];
  }
  return null;
}
let censoMemo = null;
/** Las copias de trabajo bajo la raíz de repos, FUERA de las temporales, con la identidad de su `origin`. */
function copiasDeTrabajo() {
  if (censoMemo) return censoMemo;
  const out = { raiz: null, motivo: '', copias: [] };
  const lib = path.join(__dirname, '..', 'lib', 'repos-root.js');
  if (!fs.existsSync(lib)) { out.motivo = 'sin repos-root.js al lado'; return (censoMemo = out); }
  let raiz = null;
  try { raiz = require(lib).resolveReposRoot().root; } catch (e) { out.motivo = `la raíz de repos no se pudo leer (${(e && e.message) || e})`; return (censoMemo = out); }
  if (!raiz || !fs.existsSync(raiz)) { out.motivo = 'sin raíz de repos'; return (censoMemo = out); }
  out.raiz = raiz;
  const cola = [[raiz, 0]];
  let vistas = 0;
  while (cola.length && vistas < CENSO_TOPE) {
    const [dir, nivel] = cola.shift();
    vistas++;
    if (enTemporal(dir)) continue;
    if (fs.existsSync(path.join(dir, '.git'))) {
      const id = identidadRemoto(origenDeCopia(dir) || '');
      if (id) out.copias.push({ dir, id });
      continue;   // adentro de una copia no se buscan otras
    }
    if (nivel >= CENSO_PROFUNDIDAD) continue;
    let hijos = [];
    try { hijos = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const h of hijos) {
      if (h.isDirectory() && !h.name.startsWith('.') && !CENSO_SALTEA.has(h.name)) cola.push([path.join(dir, h.name), nivel + 1]);
    }
  }
  if (cola.length) out.motivo = `censo cortado en ${CENSO_TOPE} carpetas`;
  return (censoMemo = out);
}
const laboratorioMemo = new Map();
/** ¿El repo es de laboratorio? `{ laboratorio, por, ... }` — el criterio, en la cabecera. Ante la duda, `false`. */
function juzgarLaboratorio(root) {
  const k = real(root);
  if (laboratorioMemo.has(k)) return laboratorioMemo.get(k);
  const juicio = (() => {
    if (!enTemporal(root)) return { laboratorio: false, por: 'fuera-de-las-temporales' };
    const rem = resolverRemoto(root);
    // un clon de una copia de trabajo de afuera (su `origin` es una ruta que sale de las temporales): repo de verdad
    if (rem.dir && !enTemporal(rem.dir)) return { laboratorio: false, por: 'clon-de-una-copia-de-afuera', copia: rem.dir };
    if (!rem.id) return rem.por === 'sin-origin' ? { laboratorio: true, por: 'sin-remoto' } : { laboratorio: false, por: rem.por };
    const censo = copiasDeTrabajo();
    if (!censo.raiz) return { laboratorio: false, por: 'sin-raiz-de-repos', motivo: censo.motivo };
    const igual = censo.copias.find((c) => mismaIdentidad(c.id, rem.id));
    if (igual) return { laboratorio: false, por: 'mismo-remoto-que-una-copia-de-afuera', copia: igual.dir };
    // un censo cortado no vio todo: no se puede decir que no hay copia afuera
    if (censo.motivo) return { laboratorio: false, por: 'censo-incompleto', motivo: censo.motivo };
    return { laboratorio: true, por: 'remoto-sin-copia-fuera-de-las-temporales', raiz: censo.raiz };
  })();
  laboratorioMemo.set(k, juicio);
  return juicio;
}
const laboratoriosVistos = [];

// ── record ─────────────────────────────────────────────────────────────────────────────────────
function record(event) {
  const cmd = String((event.tool_input && event.tool_input.command) || '');
  // Modo `pr` del merge (H4 del pase adversarial 2026-08-30): el único push es a dev y el
  // merge a main lo hace ADO server-side — sin esta rama, ningún merge por PR registraba
  // retrospectiva y el paso 10b volvía a depender de la memoria del agente (la falla exacta
  // que este hook existe para cerrar, incident-log#retro-multi-repo-2026-08-24).
  // 🔴 ALGÚN `pr create` de la cadena apuntando a main, no sólo el primero (revisión adversarial
  // 2026-09-06): `… create -t dev && … create -r R2 -t main` no registraba el merge. Mismo patrón
  // que pr-auto-complete-guard.js, que recorre todos los segmentos.
  const creates = az.pareceAzPr(cmd) ? az.segmentos(cmd).filter((seg) => az.verboDePr(seg) === 'create') : [];
  const prTarget = creates.map((seg) => String(az.flagDe(seg, 'target-branch', 't') || '')).find((t) => /^(main|master)$/.test(t)) || '';
  const isPrCreate = /^(main|master)$/.test(prTarget);
  // El filtro grueso se le pregunta al comando CON LO CITADO TAPADO: un `git push` entre comillas es
  // texto, no un push. Sin esto, cualquier `grep -rn "git push origin main" …` o `node -e` con
  // strings caía en el aviso de "no pude resolver" + exit 2 — le saltó 3 veces al pase adversarial
  // del 2026-09-15 en una sola revisión, y un control ruidoso termina en TYCON_RETRO_PENDING=0.
  // El precio declarado: un `sh -c "git push origin main"` queda del lado de "mencionado" y no se
  // ve. Es el mismo precio que ya se paga por los heredocs, y va al lado barato: 0 de los 23 pushes
  // del ledger real tienen esa forma.
  // `cmdShell`: el comando sin los cuerpos de heredoc que son texto (ver el require de sinHeredocs).
  // Sólo el camino del push lo usa; el del PR ya corta sus segmentos sin heredocs (az-pr.js).
  const cmdShell = sinHeredocs(cmd, { salvoShell: true });
  const cwd = event.cwd || process.cwd();
  // Los pedidos de GitHub (`gh pr create` hacia la rama principal): la entrega de un repo que vive ahí.
  const pedidosGh = pedidosDeGh(cmd, cwd, /powershell|pwsh/i.test(String(event.tool_name || '')));
  const hayPush = /\bgit\b[^|;&\n]*\bpush\b/.test(sinLoCitado(cmdShell));
  if (!isPrCreate && !hayPush && !pedidosGh.length) return;

  // ¿Dónde corre cada entrega de este comando? Con el `cd`/`-C` seguidos, no con el cwd de la
  // sesión. `puntos` trae una entrada por entrega; `resuelto:false` es "no sé", y eso NO se
  // convierte en el repo de la sesión: se dice más abajo.
  const puntos = isPrCreate
    ? pedidosDeAz(cmd, cwd)   // story 7.25: cada pedido con SU repo, o «no sé» (nunca la carpeta de la sesión a ciegas)
    // `envoltorios: true`: un `time git push` o un `/usr/bin/git push` son un push. Acá se REGISTRA
    // lo que ya pasó, así que reconocer de más no frena a nadie; no verlo sí pierde una
    // retrospectiva (o, peor, la publica como "no pude resolver" habiendo podido).
    : (hayPush ? destinoGit.destinos(cmdShell, cwd, GIT_PUSH, { envoltorios: true }) : []);
  // El filtro grueso vio un `git push` que el análisis por sentencia no ubicó (dentro de un
  // `sh -c "…"`, de un heredoc, de una sustitución): tampoco se sabe a qué repo fue. `mencion`
  // separa ese caso del otro "no sé": acá NINGÚN statement tiene forma de `git push`, así que lo
  // más probable es que el comando HABLE de un push en vez de hacerlo — y de eso no se avisa
  // (ver la condición del aviso, más abajo).
  if (!puntos.length && (isPrCreate || hayPush)) puntos.push({ dir: cwd, st: cmd, resuelto: false, mencion: true });

  const anotadas = [];
  let irresoluble = false;
  // Un pedido de GitHub que no se pudo ubicar (la carpeta o el repo los arma la terminal, o el `--repo` no es el
  // `origin` de esa carpeta) tampoco se anota contra el repo de la sesión: se dice, igual que el push de abajo.
  let pedidoSinUbicar = false;
  for (const p of pedidosGh) {
    if (!p.resuelto) { pedidoSinUbicar = true; continue; }
    const e = anotar(event, cmd, { dir: p.dir, st: cmd }, { isPrCreate: true, prTarget: p.target, sha: p.sha });
    if (e) anotadas.push(e);
  }
  // 🔴 Cada entrega se juzga por SÍ MISMA. Hubo un dedup por directorio acá y descartaba entregas
  // que nadie había juzgado todavía: con `git push origin dev && git push origin main` desde una
  // sesión parada en dev, el primer push consumía el repo, `anotar` devolvía null (no nombra main,
  // no está en main) y el segundo —el que SÍ iba a main— se salteaba: exit 0, sin entrada y sin
  // aviso (pase adversarial 2026-09-15, hallazgo #1; esa forma exacta está en el ledger real de
  // Lapacho/Backend). Registrar de menos y en silencio es el peor modo de falla de esta pieza.
  // No hace falta dedup: `anotar` ya se niega a repetir una entry con el mismo repoPath + sha.
  for (const p of puntos) {
    if (!p.resuelto) { irresoluble = true; continue; }
    const e = anotar(event, cmd, p, { isPrCreate, prTarget, sha: p.sha, punta: p.punta });
    if (e) anotadas.push(e);
  }
  // "No pude saber a qué repo fue" no se publica como si fuera el repo de la sesión — que es
  // exactamente el defecto que este arreglo cierra. Se dice. Y se dice SÓLO cuando había algo que
  // registrar (el push nombra main/master, o es un PR a main): avisar en cada push a una rama de
  // trabajo con una variable adentro sería el camino corto a TYCON_RETRO_PENDING=0.
  // 🔴 Y SÓLO cuando había un push, no cuando se lo mencionó (`!p.mencion`, 2ª vuelta del pase
  // adversarial 2026-09-15, §3): medido sobre 3192 comandos Bash reales de 60 días, el aviso
  // saltaba 28 veces y 26 eran TEXTO — 20 heredocs que describen un push (`cat > … <<'EOF'`), 4
  // `git stash push -m "… main"`, 1 rama `tmp-direct-push`, 1 `python3 -c` con el push en un
  // string —, casi todas en sesiones del propio arnés, donde la versión anterior callaba. ~1 falso
  // cada 2-3 días es la vía corta a TYCON_RETRO_PENDING=0. Lo que SÍ tiene forma de git y no se
  // puede ubicar (`git -C "$DEST" push`, `cd "$D" && git push`, el `do git -C $r push` de un
  // `for` — los 2 avisos legítimos de esos 60 días) sigue avisando: no es una mención, es un push
  // que no pude atribuir. Registrar de menos sigue siendo el peor modo de falla de esta pieza, y
  // este recorte no lo toca: el punto sintético NUNCA anota nada (es `resuelto:false`), así que
  // acá no se pierde ni una entrada — sólo el aviso.
  if (pedidoSinUbicar || (irresoluble && (isPrCreate || puntos.some((p) => !p.resuelto && !p.mencion && /\bpush\b[^|;&\n]*\b(main|master)\b/.test(p.st || cmd))))) {
    const motivosAz = puntos.filter((p) => isPrCreate && !p.resuelto && p.motivo).map((p) => p.motivo);
    const que = pedidoSinUbicar
      ? 'ese pedido de GitHub hacia main (la carpeta o el repo los arma la terminal, o el --repo del comando no es el origin de esa carpeta)'
      : isPrCreate
        ? `ese pedido de merge a main (az repos pr create: ${[...new Set(motivosAz)].join('; ') || 'no se sabe en qué repo corrió'})`
        : 'ese push a main (una variable que el comando no define, o un git adentro de otro comando)';
    process.stderr.write(`retro-pending: no pude resolver a qué repo fue ${que} — NO lo registro contra este repo: sería una atribución falsa. Si fue un merge a main, corré el latido nombrando el repo y el merge: node "${LATIDO}" --repo <repo> --merge <sha>.\n`);
    process.exit(2);
  }
  const labLineas = laboratoriosVistos.map((l) => `retro-pending: push a main desde un repo de LABORATORIO (${l.root}: vive en una carpeta temporal y ${l.por === 'sin-remoto' ? 'no tiene origin' : 'ninguna copia de trabajo fuera de las temporales tiene su remoto'}) — NO lo registro. Si era un merge de verdad, corré el latido: node "${LATIDO}" --repo "${l.root}" --merge ${l.sha || '<sha>'}`);
  if (!anotadas.length) {
    if (labLineas.length) { process.stderr.write(labLineas.join('\n') + '\n'); process.exit(2); }
    return;
  }
  // stderr + exit 2, no stdout (2026-08-27): en PostToolUse el stdout va SOLO al debug log — el
  // agente jamás lo veía. Canal documentado que sí llega al modelo: stderr con exit 2 (la
  // herramienta ya corrió; no bloquea nada, sólo hace visible el aviso). Mismo arreglo que
  // missing-path-notice; el hallazgo fue de la revisión adversarial del 35737a8.
  const fmt = (e) => `${path.basename(e.repoPath)} @ ${e.sha}`;
  const reclamadas = anotadas.filter((e) => !e.exento);
  const exentas = anotadas.filter((e) => e.exento);
  const lineas = [];
  if (reclamadas.length) lineas.push(`retro-pending: push a ${reclamadas[0].branch} registrado (${reclamadas.map(fmt).join(', ')}). Antes de cerrar el turno, corré el latido por ese merge (regla 10b — el Stop-gate exige el archivo): ${reclamadas.map(launchHint).join(' · ')}`);
  // La exención se DICE, con los archivos: el agente que sigue el paso 10b del skill de merge necesita el
  // contra-aviso, y quien lea el log necesita poder discutir el criterio con el dato a la vista.
  for (const e of exentas) {
    const lista = (e.archivos || []).slice(0, 5).join(', ') + ((e.archivos || []).length > 5 ? ` +${e.archivos.length - 5}` : '');
    lineas.push(`retro-pending: push a ${e.branch} EXENTO de retrospectiva (${fmt(e)}; sólo tests/docs: ${lista}). Queda contado en el ledger; NO lances el latido ni el agente por este push.`);
  }
  lineas.push(...labLineas);
  process.stderr.write(lineas.join('\n') + '\n');
  process.exit(2);
}

// ── a qué repo va cada `az repos pr create` hacia main (story 7.25 del arnés, 2026-10-15) ──────────
// La DETECCIÓN sigue siendo la del lector compartido (az.segmentos sobre el comando entero, con conciencia de comillas);
// acá se averigua el REPO de cada pedido. Hasta la 7.25 esto era `dirDelPrCreate`, y estaba roto de una forma que nadie
// veía: le pasaba a `az.verboDePr` el TEXTO de la sentencia cuando ese lector espera las fichas ya cortadas; tiraba
// (`seg.filter is not a function`), el `catch` lo tapaba y devolvía la carpeta de la sesión. O sea que ningún `cd` de un
// pedido se siguió nunca: con la sesión en la carpeta que agrupa los repos (no es un repo), el pedido no dejaba entrada y
// el hook salía 0 sin decir nada — dos veces medido, 2026-09-24 y 2026-10-14, en el mismo producto del equipo.
// Ahora, por cada pedido hacia main:
//   · la carpeta: la de la sesión con los `cd` del comando seguidos; un `cd` que no se puede resolver es «no sé»;
//   · el repo: si `--repository` es un nombre escrito, el repo cuyo `origin` es ESE repositorio — la carpeta, uno de
//     sus subdirectorios o uno de sus hermanos (mismo padre); si viene en una variable o no viene, el repo de la carpeta;
//   · sin repo: «no sé» (`resuelto:false`) — quien llama lo dice; nunca se anota contra la carpeta de la sesión, que
//     sería la atribución falsa que este hook ya cerró para los pushes el 2026-09-15.
// La punta es la de `--source-branch` si el repo la conoce (local o del remoto), y si no la de HEAD.
/**
 * La identidad del `origin` de un repo, en tres estados que NO se mezclan (revisores de la 7.25):
 *   `{ estado: 'nombre', nombre }` · `{ estado: 'sin-identidad' }` (no tiene origin, o es uno que no es un remoto) ·
 *   `{ estado: 'error' }` (leerlo falló). Sólo «sin identidad» deja caer al repo de la carpeta; un error es «no sé».
 */
function identidadDelOrigin(root) {
  let r;
  try { r = resolverRemoto(root); } catch { return { estado: 'error' }; }
  // Sólo un origin de AZURE tiene un nombre comparable con el `--repository` de `az repos`: uno de GitHub (u otro host)
  // no lo contradice ni lo confirma — es «sin identidad» para esta pregunta (lo pide retro-heartbeat.test.sh T20).
  if (r && r.id && r.id.nombre && r.id.org) return { estado: 'nombre', nombre: String(r.id.nombre).toLowerCase() };
  if (r && r.id) return { estado: 'sin-identidad' };
  if (r && (r.por === 'sin-origin' || r.por === 'remoto-ilegible')) return { estado: 'sin-identidad' };
  return { estado: 'error' };   // tope de saltos o una respuesta que no se entiende
}
function raizGit(dir) { return dir && fs.existsSync(dir) ? git(dir, ['rev-parse', '--show-toplevel']) : null; }
/** ¿git no pudo contestar en una carpeta que SÍ parece un repo (tiene .git)? — dueño distinto, safe.directory, git roto */
function gitNoContesto(dir) { return Boolean(dir) && fs.existsSync(path.join(dir, '.git')) && !raizGit(dir); }
function subcarpetas(dir, errores) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(dir, e.name)); }
  catch (e) { errores.push(`no pude listar ${dir} (${e.code || e.message})`); return []; }
}
/**
 * El repo cuyo origin se llama `nombre`, buscando en la carpeta, sus hijos y sus hermanos: `{ root, errores }`, con
 * `root` null si no está. `errores` junta lo que no se pudo mirar (una carpeta que no se lista, un origin que no se lee),
 * para que el «no pude resolver» diga el motivo real y no «ningún repo con ese origin».
 */
function repoPorNombre(dir, nombre) {
  const buscado = String(nombre).toLowerCase();
  const errores = [];
  const propia = raizGit(dir);
  const padre = path.dirname(propia || dir);
  const candidatas = [propia, ...subcarpetas(dir, errores), ...subcarpetas(padre, errores)].filter(Boolean);
  const vistas = new Set();
  for (const c of candidatas) {
    const root = raizGit(c);
    if (!root && gitNoContesto(c)) { errores.push(`git no pudo leer ${c}`); continue; }
    if (!root || vistas.has(root)) continue;
    vistas.add(root);
    const id = identidadDelOrigin(root);
    if (id.estado === 'nombre' && id.nombre === buscado) return { root, errores };
    if (id.estado === 'error') errores.push(`no pude leer el origin de ${root}`);
  }
  return { root: null, errores };
}
function pedidosDeAz(cmd, base) {
  const out = [];
  let statements = [];
  let errorAlRecorrer = null;
  try { statements = destinoGit.recorrer(cmd, base).statements; } catch (e) { statements = []; errorAlRecorrer = (e && e.message) || String(e); }
  for (const s of statements) {
    // Un error al leer UNA sentencia no puede perder el pedido en silencio (el `catch` de main sale 0): se dice.
    try {
      const p = pedidoDeUnaSentencia(s);
      if (p) out.push(p);
    } catch (e) {
      out.push({ resuelto: false, st: s.st, motivo: `error al leer el pedido (${(e && e.message) || e})` });
    }
  }
  // El lector de sentencias no ubicó el pedido (adentro de otro comando, de un heredoc): no se sabe dónde corrió.
  if (!out.length) {
    out.push({ resuelto: false, st: cmd, motivo: errorAlRecorrer ? `no pude leer el comando (${errorAlRecorrer})` : 'el pedido está adentro de otro comando' });
  }
  return out;
}

/** El punto de UNA sentencia `az repos pr create` hacia main, o null si la sentencia no es eso. */
function pedidoDeUnaSentencia(s) {
  {
    if (s.esCd || !az.pareceAzPr(s.st)) return null;
    const seg = az.segmentos(s.st).find((x) => az.verboDePr(x) === 'create');
    if (!seg) return null;
    if (!/^(main|master)$/.test(String(az.flagDe(seg, 'target-branch', 't') || ''))) return null;
    if (!s.dir) return { resuelto: false, st: s.st, motivo: 'un cd que no se pudo seguir' };
    const repoFlag = az.flagDe(seg, 'repository', 'r');
    const escrito = repoFlag && !/[$`]/.test(repoFlag) && repoFlag !== 'true' ? repoFlag : null;
    let root = null;
    let motivo = null;
    if (escrito) {
      const busqueda = repoPorNombre(s.dir, escrito);
      root = busqueda.root;
      // Sin coincidencia, el repo de la carpeta vale SÓLO si su origin no se puede leer (sin origin, o uno que no es un
      // remoto): ahí no hay identidad que contradiga al --repository, y es lo que hacía este hook antes de la 7.25.
      const propia = root ? null : raizGit(s.dir);
      const idPropia = propia ? identidadDelOrigin(propia) : null;
      if (idPropia && idPropia.estado === 'sin-identidad') root = propia;
      if (!root) {
        if (idPropia && idPropia.estado === 'error') busqueda.errores.push(`no pude leer el origin de ${propia}`);
        if (!propia && gitNoContesto(s.dir)) busqueda.errores.push(`git no pudo leer ${s.dir}`);
        const errores = [...new Set(busqueda.errores)];
        motivo = errores.length
          ? `--repository ${escrito}: no lo encontré y hubo lo que no pude mirar — ${errores.slice(0, 3).join('; ')}`
          : `--repository ${escrito}: ningún repo con ese origin en la carpeta, sus hijos ni sus hermanos`;
      }
    } else {
      root = raizGit(s.dir);
      if (!root) {
        motivo = gitNoContesto(s.dir)
          ? `git no pudo leer ${s.dir} (¿otro dueño o safe.directory?) y --repository no nombra un repo`
          : 'la carpeta del comando no es un repo y --repository no nombra uno';
      }
    }
    if (!root) return { resuelto: false, st: s.st, motivo };
    const fuente = az.flagDe(seg, 'source-branch', 's');
    const ref = fuente && !/[$`]/.test(fuente) ? [`refs/heads/${fuente.replace(/^refs\/heads\//, '')}`, `refs/remotes/origin/${fuente.replace(/^refs\/heads\//, '')}`]
      .find((r) => git(root, ['rev-parse', '--verify', '--quiet', r])) : null;
    // Sin la rama de --source-branch en este clon, la punta es la de HEAD, y la entrada lo dice (`punta`): puede no ser
    // lo que se mergea. No es un «no sé» que frene: HEAD es la mejor punta conocida y el merge sí fue de este repo.
    const punta = ref ? null : (fuente && !/[$`]/.test(fuente) ? `HEAD: la rama ${fuente} no está en este clon` : 'HEAD: el pedido no nombra --source-branch legible');
    return { resuelto: true, dir: root, st: s.st, sha: ref ? git(root, ['rev-parse', ref]) : null, punta };
  }
}

// ── los pedidos de GitHub ──────────────────────────────────────────────────────────────────────────
// Un repo que vive en GitHub entrega con `gh pr create` hacia la rama principal, como uno de Azure con
// `az repos pr create`. Sin esto, ahí ningún merge por pedido dejaba entrada y la retrospectiva volvía a
// depender de que alguien se acordara. El comando lo lee el lector COMPARTIDO de `gh` (scripts/lib/gh-pr.js,
// el mismo del freno antes de publicar): acá no hay otro regex.
// 🔴 Este hook viaja suelto (el banco y las pruebas lo copian con sus librerías, a mano): el lector se carga
// sólo si el comando parece traer un `gh` y si el archivo está al lado. Sin él, calla como antes de existir.
function lectorDeGh(cmd) {
  if (!/gh/i.test(cmd)) return null;   // el descarte barato; si el comando trae un `gh` lo decide el lector, no otro regex
  const lib = path.join(__dirname, '..', 'lib', 'gh-pr.js');
  if (!fs.existsSync(lib)) return null;
  const lector = require(lib);
  return lector.pareceGh(cmd) ? lector : null;
}

/** La rama a la que va un pedido que no trae `--base`: la que dice git en local, sin red. `null` = no lo dice. */
function basePorDefecto(dir, rama) {
  // `gh` mira primero `branch.<rama>.gh-merge-base`, y si no la rama por defecto del repo
  const propia = rama ? gitOrNull(dir, ['config', '--get', `branch.${rama}.gh-merge-base`]) : null;
  if (propia) return propia;
  const remota = gitOrNull(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  return remota ? remota.replace(/^origin\//, '') : null;
}

/**
 * Los `gh pr create` (o `gh pr new`) de un comando que son una entrega hacia la rama principal.
 * Cada uno: `{ resuelto: true, dir, target, sha }`, o `{ resuelto: false }` si no se sabe en qué carpeta corre o
 * a qué repo va — eso NO se convierte en el repo de la sesión: quien llama lo dice y no anota.
 *   · base `main`/`master` literal → se anota · otra rama literal → no es una entrega
 *   · sin `--base` → lo que diga git en local; si no dice nada, la principal · base que arma la terminal → la principal
 *     (de más, nunca de menos: lo caro de esta pieza es anotar de menos y en silencio)
 *   · un simulacro (`--dry-run`) y un pedido de ayuda (`--help`) no crean nada
 *   · un `gh` MENCIONADO como argumento de otro programa (`echo gh pr create`, un buscador) no es un pedido: ni se
 *     anota ni se avisa; uno que otro programa LANZA (`xargs gh …`) sí corre, y no se sabe desde dónde: se dice
 *   · un `gh` que el lector no pudo leer (adentro de un `bash -c "…"`) no se ve: límite declarado
 */
function pedidosDeGh(cmd, cwd, powershell) {
  const lector = lectorDeGh(cmd);
  if (!lector) return [];
  const out = [];
  for (const c of lector.comandosGh(cmd, 0, { powershell })) {
    // el verbo puede venir después de la opción del repo (`gh pr -R dueño/repo create`): el lector lo da aparte
    const verbo = c.verbo || c.verboTrasOpciones;
    if (c.grupo !== 'pr' || (verbo !== 'create' && verbo !== 'new') || c.lectura || c.simulacro) continue;
    if (c.porOtroPrograma && !c.loLanzaOtro) continue;
    if (c.base && !/^(main|master)$/.test(c.base)) continue;
    if (c.cwdDesconocido || c.cdIncierto || c.repoDesconocido) { out.push({ resuelto: false }); continue; }
    // los `cd` literales de la línea, en orden; `~` es la carpeta de la persona (la terminal la expande, `path` no)
    const dir = (c.cds || []).reduce((d, paso) => path.resolve(d, String(paso).replace(/^~(?=$|[\\/])/, os.homedir())), cwd);
    const root = git(dir, ['rev-parse', '--show-toplevel']);
    if (!root) { out.push({ resuelto: false }); continue; }
    if (c.repo) {
      // `--repo`/`GH_REPO` nombran un repo: si no es el `origin` de esta carpeta, el pedido es de OTRO repo
      const origen = identidadRemoto(git(root, ['remote', 'get-url', 'origin']));
      if (!origen || origen.ruta !== c.repo) { out.push({ resuelto: false }); continue; }
    }
    // la punta: la de `--head` si nombra una rama de este clon, o la que el clon conoce del remoto (la rama se empujó
    // desde otro lado); con `dueño:rama` es la de otro repo, y si no está en ningún lado, la de HEAD
    const propia = c.head && !c.head.includes(':') ? c.head : null;
    const refDeLaRama = propia && [`refs/heads/${propia}`, `refs/remotes/origin/${propia}`].find((ref) => git(root, ['rev-parse', '--verify', '--quiet', ref]));
    const rama = refDeLaRama ? propia : git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    let target = c.base;
    if (!target) {
      // una base que arma la terminal —o que quedó después de donde el lector tuvo que cortar— «no se sabe»: la principal
      const noSeSabe = c.baseDesconocida || c.cortado;
      const porDefecto = noSeSabe ? null : basePorDefecto(root, rama);
      if (porDefecto && !/^(main|master)$/.test(porDefecto)) continue;
      target = porDefecto || 'main';
    }
    out.push({ resuelto: true, dir: root, target, sha: refDeLaRama ? git(root, ['rev-parse', refDeLaRama]) : null });
  }
  return out;
}

/** Anota UNA entrega en el ledger. Devuelve la entry escrita, o null si no correspondía. */
function anotar(event, cmd, punto, ctx) {
  const root = git(punto.dir, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  // Repo bajo el arnés: .tycon/ o artefactos del pipeline. Un repo suelto no debe retrospectiva.
  if (!fs.existsSync(path.join(root, '.tycon')) && !fs.existsSync(path.join(root, '.advisors'))) return null;
  // Los repos DEL arnés (agent-skills / el arnés) se trabajan directo en main, sin story
  // ni pipeline: no hay retrospectiva que correr (misma POLÍTICA que el portón de carril,
  // lib/story-gate.js HARNESS_REPO_SEGMENTS). Falso positivo real el 2026-08-24: el primer push de
  // este mismo hook quedó registrado como merge pendiente. 🔴 Esta exclusión es también la que el
  // bug del 2026-09-15 dejaba sin efecto: con el repo mal calculado, nunca llegaba a mirarla.
  // Desde el 2026-09-17 se decide por el REMOTO, no por la carpeta ("QUIÉN ES EL ARNÉS", en la cabecera).
  if (esRepoDelArnes(root)) return null;
  // La rama y el destino se leen de LA SENTENCIA, no del comando entero: una línea con dos pushes
  // a ramas distintas habla de las dos, y cada repo tiene que juzgarse por lo suyo.
  const st = punto.st || cmd;
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // `main` tiene que ser un REFSPEC suelto (`origin main`, `HEAD:main`, `HEAD:refs/heads/main`), no un
  // pedazo del nombre de otra rama. Con `\bmain\b` el guion cuenta como borde de palabra, y el push de la
  // rama `chore/bajar-main-a-dev` quedó anotado como push a main con la punta vieja de origin/main (caso
  // real 2026-09-18, en el repo de historias de un producto del equipo — guides/incident-log.md#case-push-branch-named-main-2026-09-18; bench `quiet-push-de-una-rama-con-main-en-el-nombre`).
  const mentionsMain = /\bpush\b[^|;&\n]*(?:[\s:"']|refs\/heads\/)(main|master)(?=$|[\s;&|"'])/.test(st);
  const onMain = /^(main|master)$/.test(branch) && !/\bpush\b[^|;&\n]*\b(dev|develop|feat|feature|fix|hotfix|release)\b/.test(st);
  if (!ctx.isPrCreate && !mentionsMain && !onMain) return null;
  // Un repo de laboratorio no debe retrospectiva: no se anota, y `record` lo dice (cabecera, «LOS REPOS DE LABORATORIO»).
  const lab = juzgarLaboratorio(root);
  if (lab.laboratorio) { laboratoriosVistos.push({ root, sha: git(root, ['rev-parse', 'HEAD']).slice(0, 12), ...lab }); return null; }
  const target = ctx.prTarget === 'master' || (!ctx.isPrCreate && (/\bmaster\b/.test(st) || branch === 'master')) ? 'master' : 'main';
  // Qué trajo el push (2026-09-16, "EL BUCLE" y "LA RETRO QUE NO APORTA NADA" en la cabecera). Se decide
  // sobre el repo al que se empujó, antes de leer la sha. Sólo para pushes: en el modo PR el merge lo
  // hace ADO y acá no hay rango que leer. Salida de retro → sin entrada, como antes. Sólo tests/docs →
  // entrada EXENTA (constancia + cuenta). Cualquier otra cosa → entrada que pide retrospectiva.
  const juicio = ctx.isPrCreate ? null : juzgarPush(root, target);
  if (juicio && juicio.retro) return null;
  // Para un PR el merge todavía no existe: el sha que identifica la entrega es la punta de la
  // SOURCE (lo que ADO va a mergear), no origin/main (que sigue en el estado previo).
  // Para un push, `origin/<target>` se lee EN EL REPO AL QUE SE EMPUJÓ, que el push acaba de
  // actualizar: la sha stale del incidente venía de leerla en el checkout equivocado, no de la ref.
  // (Un pedido de GitHub puede nombrar su rama con `--head`: ahí la punta es la de ESA rama, y llega en `ctx.sha`.)
  const sha = ctx.isPrCreate
    ? (ctx.sha || git(root, ['rev-parse', 'HEAD']))
    : (git(root, ['rev-parse', `origin/${target}`]) || git(root, ['rev-parse', target]) || git(root, ['rev-parse', 'HEAD']));
  if (!sha) return null;
  const entry = { ts: new Date().toISOString(), sessionId: sessionIdOf(event), repoPath: root, sha: sha.slice(0, 12), branch: target, cmd: cmd.slice(0, 120) };
  if (juicio && juicio.exento) Object.assign(entry, { exento: juicio.exento, motivo: juicio.motivo, commits: juicio.commits, archivos: juicio.archivos.slice(0, 40) });
  if (ctx.isPrCreate && !ctx.sha && ctx.punta) entry.punta = ctx.punta;   // story 7.25: la punta cayó a HEAD, dicho
  if (readJsonl(LEDGER).some((e) => e.repoPath === root && e.sha === entry.sha)) return null;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

// ── ¿qué trajo este push? salida de retro · sólo tests/docs · o algo que pide retrospectiva ─────
// (2026-09-16: "EL BUCLE" y "LA RETRO QUE NO APORTA NADA" en la cabecera.) Un solo lector del rango
// `origin/<target>@{1}..origin/<target>` —el reflog del remote-tracking ref, que el propio push acaba de
// mover ("update by push"; medido 2026-09-16 con clone, con init+fetch y con push)— y tres preguntas
// sobre él, en este orden: ¿todo es salida de retro? ¿cierra una story? ¿todo es tests/docs?
// Alcanza con UNA entrada del reflog: cada una guarda el valor viejo, así que en un clon fresco `@{1}`
// tras el primer push es donde estaba el remoto (git avisa "only has 1 entries" por stderr y resuelve
// igual). Sin entrada no hay rango —`core.logAllRefUpdates=false`, remoto que no se llama origin— y
// "no sé" se contesta SIN exención: se registra, como siempre. No se usa el reflog de la rama LOCAL a
// propósito: `main@{1}` es el commit anterior de la máquina, no lo que había en el remoto, y diría
// "trajo un commit" de un push que trajo cinco — hacia MENOS control.
// Así se titulan los commits de salida del capturer (los reales de este repo: `chore(retro 2.6): …`,
// `chore(retro 4.2): …`, `chore(retro): …`): el `\b` deja pasar `chore(retro):` y `chore(retro 2.6):`,
// no `chore(retrospectiva)`. Es una convención de mensaje (un commit titulado así a mano la esquiva —
// el mismo precio que `[skip ci]`); la exención por tests/docs, en cambio, mira ARCHIVOS.
const COMMIT_DE_RETRO = /^chore\(retro\b/;
// Lo que exime por ARCHIVO. Segmentos de directorio, no sufijos: `scripts/tests/x.sh`, `src/__tests__/a.tsx`
// y `tests/e2e/b.spec.ts` sí; un `foo.test.js` suelto en `src/` NO (hacia más control, límite declarado).
const DIR_DE_TESTS = /^(?:.*\/)?(?:tests|__tests__)\/.+/;
function archivoExento(f) {
  return DIR_DE_TESTS.test(f) || /\.md$/i.test(f) || /^\.dashboard\//.test(f) || /^\.engram\//.test(f);
}
/**
 * @returns {{rango:boolean, retro:boolean, exento:null|'solo-tests-docs', archivos:string[], commits:number, motivo:string}}
 *   rango:false → no se pudo saber qué trajo el push (se registra, sin exención).
 *   retro:true  → todos los commits son salida de una retrospectiva (sin entrada).
 *   exento      → 'solo-tests-docs' o null; `motivo` dice por qué en castellano.
 */
function juzgarPush(root, target) {
  const nada = (motivo) => ({ rango: false, retro: false, exento: null, archivos: [], commits: 0, motivo });
  const antes = git(root, ['rev-parse', '--verify', '-q', `origin/${target}@{1}`]);
  const ahora = git(root, ['rev-parse', '--verify', '-q', `origin/${target}`]);
  if (!antes || !ahora) return nada(`sin reflog de origin/${target}: no sé qué trajo el push`);
  if (antes === ahora) return nada(`el push no movió origin/${target}`);
  const asuntos = git(root, ['log', '--format=%s', `${antes}..${ahora}`]).split('\n').filter(Boolean);
  // Un rango VACÍO no es "todos son de retro" ni "no tocó nada": `[].every` daría true y eximiría un
  // push del que no se sabe nada. Cero commits, o un `git log` que falló, → se registra.
  if (!asuntos.length) return nada('rango vacío o ilegible');
  const juicio = (retro, exento, archivos, motivo) => ({ rango: true, retro, exento, archivos, commits: asuntos.length, motivo });
  if (asuntos.every((s) => COMMIT_DE_RETRO.test(s))) return juicio(true, null, [], 'todos los commits son salida de una retrospectiva');
  // Unión de los archivos de TODOS los commits del rango (no el diff neto: un archivo tocado y revertido
  // adentro del mismo push también cuenta — hacia más control). `gitOrNull`: un git que falla es "no sé".
  const salida = gitOrNull(root, ['log', '--name-only', '--format=', `${antes}..${ahora}`]);
  if (salida === null) return juicio(false, null, [], 'no pude listar los archivos del push');
  const archivos = [...new Set(salida.split('\n').map((l) => l.trim()).filter(Boolean))].sort();
  if (!archivos.length) return juicio(false, null, archivos, 'el push no lista archivos (commits vacíos)');
  // Cierra una story → NUNCA exento, aunque todo sea .md: evidencia bajo .advisors/ (pipeline-runs,
  // dod-runtime, review-roster) o un `status:` que cambia en un .md (el frontmatter de una story).
  if (archivos.some((f) => /^\.advisors\//.test(f))) return juicio(false, null, archivos, 'trae evidencia bajo .advisors/ (cierra una story)');
  const md = archivos.filter((f) => /\.md$/i.test(f));
  if (md.length) {
    // `-G` lista los commits cuyo diff tiene una línea que empieza con `status:` (agregada o quitada):
    // salida chica aunque el push traiga cien documentos. Si git falla, no se exime.
    const conStatus = gitOrNull(root, ['log', '--format=%H', '-G^status:', `${antes}..${ahora}`, '--', ...md]);
    if (conStatus === null) return juicio(false, null, archivos, 'no pude leer los .md del push');
    if (conStatus) return juicio(false, null, archivos, 'cambia un status: en un .md (story)');
  }
  const noExentos = archivos.filter((f) => !archivoExento(f));
  if (noExentos.length) return juicio(false, null, archivos, `toca algo que no es tests/docs: ${noExentos.slice(0, 3).join(', ')}`);
  return juicio(false, 'solo-tests-docs', archivos, 'sólo tests/docs/.dashboard/.engram, sin cerrar story');
}

// ── gate (Stop) ────────────────────────────────────────────────────────────────────────────────
// Cada merge pendiente se paga con SU archivo de métricas (story 7.1): `pendingEntries()` ya sacó los
// cubiertos por `coveredByMetrics` y los exentos, así que acá sólo se decide A QUIÉN reclamar. Hasta
// el 2026-09-16 se emparejaba cada merge con un spawn del capturer (por sha, por repo o comodín —
// incident-log#retro-gate-cuenta-sin-repo-2026-08-31); con el latido de un segundo ese
// emparejamiento dejó de tener sentido y se retiró con sus casos.
//
// Los merges AJENOS se agrupan por repo (convención de worktrees normalizada): un repo, una línea,
// con el más viejo arriba y cada merge con su comando — así se cierran todos en la misma vuelta en
// vez de gastar un bloqueo por merge.
const WORKTREE_SUFFIX = /--(merge|wt-[^\\/]*)$/; // convención de guides/git-worktrees.md
function normRepo(p) {
  const r = real(p);
  const base = path.basename(r).replace(WORKTREE_SUFFIX, '');
  return base ? path.join(path.dirname(r), base) : r;
}
function porRepo(entries) {
  const grupos = new Map();
  for (const e of entries) {
    const k = normRepo(e.repoPath);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(e);
  }
  for (const lista of grupos.values()) lista.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
  return [...grupos.values()];
}
// Alcance del reclamo ajeno: el repo, o el workspace que lo contiene UN nivel más arriba (Ceibo/ →
// CeiboBackend). Nunca una raíz que cuelga proyectos distintos (la raíz de repos, ~): desde ahí una
// sesión pasaba a ser la mula de carga de todos los proyectos, que es justo lo que el aviso de
// arranque dejó de hacer el 2026-08-28.
function nearEnough(entry, cwd) {
  const r = real(entry.repoPath);
  const c = real(cwd);
  if (underOrEqual(c, r)) return true;          // la sesión está DENTRO del repo
  if (!underOrEqual(r, c)) return false;
  const resto = r.slice(c.endsWith(path.sep) ? c.length : c.length + 1);
  return resto.split(path.sep).filter(Boolean).length <= 1;
}
function gate(event) {
  const sid = sessionIdOf(event);
  const cwd = event.cwd || process.cwd();
  const safe = String(sid).replace(/[/\\]/g, '_');
  const stateFile = path.join(STATE_DIR, `retro-gate-${safe}.count`);
  // El tope de bloqueos cuenta CONSECUTIVOS: un cierre limpio lo resetea. Vitalicio, cada nudge
  // legítimo ya cumplido gastaba presupuesto y del 4º merge en adelante la sesión no frenaba nunca
  // más — justo las sesiones largas, que son las que mergean varias veces (pase adversarial).
  const limpio = () => { try { fs.unlinkSync(stateFile); } catch { /* no existía */ } };
  const pend = pendingEntries();
  const mine = pend.filter((e) => e.sessionId === sid);
  // Merges de OTRA sesión en el repo de ÉSTA (2026-08-31, decisión del dev): el aviso de arranque
  // es un recordatorio y se puede ignorar — así una retro quedó 4 días sin correr. Acá se reclama
  // al cerrar el turno, con tres cercos: sólo el repo/workspace del cwd, sólo pasados
  // TYCON_RETRO_GATE_FOREIGN_MIN_AGE_MIN minutos (para no frenar a una sesión paralela que acaba de
  // mergear y todavía va a escribir el suyo), y sólo hasta TYCON_RETRO_GATE_FOREIGN_MAX_AGE_DAYS
  // días — más viejo que eso ya es territorio de retro-staleness-notice.js, que avisa por días sin
  // frenar a nadie.
  const minAge = Number(process.env.TYCON_RETRO_GATE_FOREIGN_MIN_AGE_MIN || 30) * 60000;
  const maxAge = Number(process.env.TYCON_RETRO_GATE_FOREIGN_MAX_AGE_DAYS || 7) * 86400000;
  const foreign = pend.filter((e) => {
    if (e.sessionId === sid || !nearEnough(e, cwd)) return false;
    // Sin fecha legible la edad es DESCONOCIDA, no infinita: se reclama igual. Tratarla como
    // antiquísima la sacaba por el techo y el pendiente desaparecía del freno sin que nadie lo
    // decidiera — el modo de falla que este control existe para no tener.
    const t = Date.parse(e.ts);
    if (!t) return true;
    const edad = Date.now() - t;
    return edad >= minAge && edad <= maxAge;
  });
  if (!mine.length && !foreign.length) return limpio();
  let blocks = 0;
  try { blocks = Number(fs.readFileSync(stateFile, 'utf8')) || 0; } catch { blocks = 0; }
  if (blocks >= MAX_BLOCKS) {
    process.stderr.write(`⚠ retro-pending: ${mine.length + foreign.length} merge(s) a main siguen sin su archivo de retrospectiva tras ${MAX_BLOCKS} bloqueos seguidos — se deja cerrar; el aviso de arranque lo va a seguir reclamando.\n`);
    return;
  }
  const cuando = (e) => String(e.ts || '').slice(0, 16);
  const lines = [];
  if (mine.length) {
    lines.push(`  Merges de ESTA sesión sin su archivo (${mine.length}):`);
    for (const e of mine) lines.push(`    - ${e.repoPath} @ ${e.sha} (${cuando(e)}) → ${launchHint(e)}`);
  }
  if (foreign.length) {
    const grupos = porRepo(foreign);
    lines.push(`  Repo(s) con merge(s) de OTRA sesión sin su archivo (${grupos.length}):`);
    for (const [primero, ...resto] of grupos) {
      lines.push(`    - ${primero.repoPath} @ ${primero.sha} (${cuando(primero)}) → ${launchHint(primero)}`);
      resto.forEach((e, i) => lines.push(`      ${i === 0 ? `y ${resto.length} más en ese repo: ` : '· '}${e.sha} (${cuando(e)}) → ${launchHint(e)}`));
    }
  }
  // El contador sube DESPUÉS de armar el mensaje: si algo revienta al renderizar, el catch global
  // se lo traga y el turno cierra — pero al menos no queda gastado un bloqueo por un Stop que no
  // avisó nada (pase adversarial 2026-08-31, entrada del ledger sin `ts`).
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(stateFile, String(blocks + 1)); } catch { /* fail-open */ }
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `⛔ retro-pending: hay ${mine.length + foreign.length} merge(s) a main sin su archivo de retrospectiva. Corré el latido (un segundo, sin modelo) por cada uno antes de cerrar el turno y commiteá su salida con \`chore(retro …)\` — paso 10b de /tycon-merge-to-main:\n${lines.join('\n')}\n  Lo que salda cada pendiente es el archivo que escribe el latido; el tycon-retrospective-capturer se usa sólo si el dev pide «retro con modelo» (y en ese caso escribe él el archivo: no hace falta además el latido).\nBloqueo ${blocks + 1}/${MAX_BLOCKS}. Casos: incident-log#retro-multi-repo-2026-08-24 · incident-log#retro-sin-modelo-2026-09-16.`,
  }) + '\n');
}

// ── notice (SessionStart) ──────────────────────────────────────────────────────────────────────
// ¿a está dentro de (o es) b? — sobre realpaths, con corte en separador (evita /Foo vs /FooBar).
function underOrEqual(a, b) {
  if (a === b) return true;
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
// Un pendiente "es de esta sesión" si su repo cae bajo el cwd (workspace que contiene repos, ej.
// Ceibo/ → CeiboBackend) o el cwd cae dentro del repo (sesión abierta en un subdirectorio).
function belongsToCwd(entry, cwd) {
  const r = real(entry.repoPath);
  const c = real(cwd);
  return underOrEqual(r, c) || underOrEqual(c, r);
}
function notice(event) {
  const minAgeMs = Number(process.env.TYCON_RETRO_PENDING_MIN_AGE_MIN || 5) * 60000;
  const old = pendingEntries().filter((e) => Date.now() - (Date.parse(e.ts) || 0) >= minAgeMs);
  // La cuenta de la exención (2026-09-16): se rinde SÓLO cuando hubo exenciones en la ventana — sin
  // ellas no hay nada que rendir, y una línea más en cada arranque es ruido que se deja de leer.
  const cuenta = contarVentana(30);
  const cuentaLine = cuenta.exentos
    ? `ℹ️ retro-pending (últimos ${cuenta.dias} días): ${cuenta.conRetro} push(es) a main con retrospectiva · ${cuenta.exentos} exento(s) por sólo tests/docs · ${cuenta.pendientes} sin retrospectiva. Detalle: node ${__filename} --report`
    : null;
  const emitir = (cuerpo) => process.stdout.write(`<system-reminder>\n${cuerpo}\n</system-reminder>\n`);
  if (!old.length) { if (cuentaLine) emitir(cuentaLine); return; }
  const scopeAll = process.env.TYCON_RETRO_PENDING_SCOPE === 'all';
  const cwd = event.cwd || process.cwd();
  const local = scopeAll ? old : old.filter((e) => belongsToCwd(e, cwd));
  const foreign = old.length - local.length;
  // La línea de "otros proyectos" es informativa a propósito: sin repo, sin sha, sin launchHint —
  // que el agente no tenga nada que lanzar. Cada pendiente se reclama en la sesión de SU repo.
  const foreignLine = foreign
    ? `ℹ️ Además hay ${foreign} merge(s) pendiente(s) de retrospectiva en OTROS proyectos — NO los lances desde esta sesión: se reclaman al abrir sesión en su propio repo (o TYCON_RETRO_PENDING_SCOPE=all para verlos).`
    : null;
  if (!local.length) {
    const cuerpo = [foreignLine, cuentaLine].filter(Boolean).join('\n');
    if (cuerpo) emitir(cuerpo);
    return;
  }
  const lines = local.map((e) => `  - ${e.repoPath} @ ${e.sha} (${String(e.ts || '').slice(0, 16)})`);
  const scopeLabel = scopeAll ? '' : ' de ESTE proyecto';
  process.stdout.write(`<system-reminder>\n🔴 retro-pending: ${local.length} merge(s) a main${scopeLabel} SIN retrospectiva (ningún metrics-*.json cubre ese repo+commit):\n${lines.join('\n')}\nLanzá el latido por cada uno, un segundo y sin modelo (${launchHint(local[0])}).${foreignLine ? '\n' + foreignLine : ''}${cuentaLine ? '\n' + cuentaLine : ''} Off: TYCON_RETRO_PENDING=0.\n</system-reminder>\n`);
}

function main() {
  if (process.env.TYCON_RETRO_PENDING === '0') return;
  // Los nombres viejos siguen andando (story 8.9, tanda B3a). Como hook corre sin argumentos: ahí ni se carga la
  // biblioteca. Sin ella al lado (una copia suelta), paso directo.
  if (process.argv.length > 2) {
    let legacy = null;
    try { legacy = require(path.join(__dirname, '..', 'lib', 'legacy-names.js')); } catch (_) { legacy = null; }
    if (legacy) legacy.aliasArgv('scripts/hooks/retro-pending.js', { exitCode: 2, prefix: 'retro-pending: ' });
  }
  // A mano, sin stdin: `--report` rinde la cuenta de la ventana (30 días, `--days N`) con las exenciones
  // una por una; `--judge [dir]` dice qué haría este hook con el ÚLTIMO push a main de ese repo (el
  // mismo criterio, para que el paso 10b del skill de merge pregunte en vez de decidir por su cuenta).
  if (process.argv.includes('--report')) {
    const i = process.argv.indexOf('--days');
    process.stdout.write(JSON.stringify(contarVentana(i >= 0 ? Number(process.argv[i + 1]) || 30 : 30), null, 2) + '\n');
    return;
  }
  if (process.argv.includes('--judge')) {
    const i = process.argv.indexOf('--judge');
    const dir = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : process.cwd();
    const root = git(dir, ['rev-parse', '--show-toplevel']);
    if (!root) { process.stdout.write(JSON.stringify({ error: `no es un repo git: ${dir}` }) + '\n'); process.exitCode = 2; return; }
    const target = /^(main|master)$/.test(git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) ? git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) : 'main';
    // `arnes` (2026-09-17): `--judge` decía qué TRAJO el push, no si este hook lo anotaría — y a un repo
    // del arnés no lo anota nunca. Se dice, con de dónde salió el dato; `exento` no cambia (sigue hablando
    // sólo de lo que trajo el push) y qué hacer con un merge del arnés lo sigue decidiendo quien pregunta.
    const arnes = juzgarRepo(root);
    const lab = juzgarLaboratorio(root);
    const juicio = juzgarPush(root, target);
    // `registraria`: ¿este hook dejaría una entrada por ese push? No, si el repo es del arnés o de laboratorio, o si todo
    // lo que trajo es salida de una retrospectiva (una entrada exenta también es una entrada).
    process.stdout.write(JSON.stringify({ repo: root, target, arnes: arnes.arnes, arnes_por: arnes.por, laboratorio: lab.laboratorio, laboratorio_por: lab.por, registraria: !arnes.arnes && !lab.laboratorio && !juicio.retro, ...juicio }, null, 2) + '\n');
    return;
  }
  let event = {};
  try { const s = fs.readFileSync(0, 'utf8'); event = s ? JSON.parse(s) : {}; } catch { event = {}; }
  const argMode = (process.argv.indexOf('--mode') >= 0) ? process.argv[process.argv.indexOf('--mode') + 1] : null;
  const evName = event.hook_event_name || '';
  const mode = argMode
    || (event.tool_name ? 'record' : null)
    || (evName === 'SessionStart' || event.source ? 'notice' : null)
    || (evName === 'Stop' || ('stop_hook_active' in event) ? 'gate' : null);
  if (mode === 'record') return record(event);
  if (mode === 'gate') return gate(event);
  if (mode === 'notice') return notice(event);
}
try { main(); } catch { /* fail-open: nunca rompe push, stop ni arranque */ }
