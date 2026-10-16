#!/usr/bin/env node
/**
 * build/deploy-codex-all.js — el ÚNICO punto de entrada del despliegue del lado Codex.
 *
 * Corre los cuatro deployers (generate --deploy · hooks · mcp · skills) con UNA política de
 * detección de cambios, de silencio y de error, invocado por los DOS instaladores
 * (install-tycon-hooks.sh y .ps1). Nació de la revisión del 2026-08-23 sobre el commit que
 * sacó los deployers del throttle del banco: esa versión inline tenía cuatro llamadas con
 * cuatro políticas distintas, ignoraba `--check`, corría entera en cada arranque, y el espejo
 * de Windows quedó con el bug viejo — dos copias del mismo bloque driftean en la primera
 * edición, y ésta lo probó.
 *
 * QUÉ RESUELVE, PUNTO POR PUNTO (cada uno fue un hallazgo confirmado de esa revisión):
 *   - `--check` NO escribe: reporta si el despliegue está al día o pendiente y sale. El
 *     contrato del instalador ("--check solo reporta") lo violaba el bloque anterior — y
 *     violarlo acá no es cosmético: el merge de hooks.json cambia hashes y Codex deja de
 *     correr los hooks hasta re-aprobar con /hooks.
 *   - FINGERPRINT contra un stamp: HEAD de los dos repos (en una versión bajada, su version.json y el commit de la capa
 *     del equipo) + estado sucio de adapters/build +
 *     mtime/size de ~/.claude.json. Sin cambios y con las salidas presentes → sale en ~5ms
 *     sin spawnear nada. Antes: 4 procesos node, el parse completo de ~/.claude.json y la
 *     caminata de 170 skills en CADA arranque, para concluir "sin cambios".
 *   - SILENCIO en el estado estable: las líneas "sin cambios" de los deployers no llegan al
 *     contexto del SessionStart. Lo único que se imprime es lo accionable: el aviso de TRUST,
 *     el nudge de adapters regenerados sin commitear, y los fallos.
 *   - FALLO CON CAUSA: si un paso falla se imprime el patrón del instalador (qué falló +
 *     "Diagnóstico: <comando>") MÁS la cola de su salida real — el "⚠ falló" sin la causa
 *     obligaba a re-correr a mano para ver el error. Un fallo NO escribe el stamp, así que se
 *     reintenta (y se re-anuncia) en el próximo arranque: un despliegue roto que persiste
 *     tiene que seguir sonando hasta que alguien lo arregle.
 *   - CLON INCOMPLETO ≠ deploy roto: si falta alguno de los cuatro scripts (git pull fallado,
 *     clon viejo) se dice ESO, una vez, en vez de cuatro avisos engañosos de "deploy falló".
 *   - El nudge que el throttle mataba: cuando generate regenera los .toml del REPO (porque el
 *     canónico cambió y nadie commiteó la regeneración), acá se avisa con el comando — el
 *     "🛑 DESACTUALIZADO" de build/check.js no puede dispararse en máquinas Codex porque este
 *     deploy regenera antes; este aviso lo reemplaza en esas máquinas.
 *
 * Uso:  node build/deploy-codex-all.js [--check] [--force] [--selftest]
 * Exit: 0 ok/al día/nada para hacer · 1 algún deployer falló.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
// story 8.23 (A2): la carpeta del estado la sabe scripts/setup/harness/tycon-home.js. Se carga SI ESTÁ, por su ruta: los
// laboratorios copian carpetas sueltas de scripts/ sin scripts/setup/; ahí vale la ruta de siempre, que es la misma (T5 de
// scripts/tests/tycon-home.test.js). Si está y no carga, tira.
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'scripts', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
const { execFileSync } = require('child_process');

const BUILD = __dirname;
const TCG = path.resolve(BUILD, '..');
// Resolución TOLERANTE de TYCON_SKILLS_DIR: la variable convive con DOS semánticas
// documentadas (raíz del clon en los deployers; carpeta de skills en el lint/backfill, cuyos
// propios mensajes de error la instruyen así) — ver scripts/lib/skills-dir.js.
// Este guion ESCRIBE rutas en la máquina: usa la variante «instalada» (story 8.18, hallazgo I12). Con «el propio
// clon primero», una máquina con dos clones cambiaría ~/.codex/hooks.json apenas el arnés traiga skills/, y Codex
// aprueba cada hook por su texto: habría que re-aprobarlos todos.
const SKILLS_REPO = require(path.join(__dirname, '..', 'scripts', 'lib', 'skills-dir.js')).resolveInstalledSkillsDirs().repo;
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const STAMP = path.join(stateDirOf(os.homedir()), 'codex-deploy-stamp.json');

// story 8.23 (tanda C): una versión BAJADA (`~/.tycon/harness`, sin `.git`) no es un repo. Ahí git no se invoca nunca
// —la huella sale del `version.json` publicado— y el árbol no se escribe: los revisores se despliegan tal como vinieron
// (`generate.js --deploy-only`), sin regenerarlos (regenerar un .toml lo dejaría «editado» para `doctor`).
const isRepo = (dir) => fs.existsSync(path.join(dir, '.git'));
const RELEASE_TREE = !isRepo(TCG);
const STEPS = [
  RELEASE_TREE
    ? { name: 'generate.js --deploy-only', script: 'generate.js', args: ['--deploy-only'], que: 'los advisors del lado Codex quedaron viejos' }
    : { name: 'generate.js --deploy', script: 'generate.js', args: ['--deploy'], que: 'los advisors del lado Codex quedaron viejos' },
  { name: 'deploy-codex-hooks.js', script: 'deploy-codex-hooks.js', args: [], que: 'los hooks del lado Codex quedaron viejos' },
  { name: 'deploy-codex-mcp.js', script: 'deploy-codex-mcp.js', args: [], que: 'los servidores MCP del lado Codex quedaron viejos' },
  { name: 'deploy-shared-skills.js', script: 'deploy-shared-skills.js', args: [], que: 'los skills del lado Codex quedaron viejos' },
];

function git(repo, ...args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

/**
 * La huella de "¿cambió algún insumo del despliegue?". Deliberadamente gruesa:
 *   - HEAD de los dos repos — los canónicos viajan commiteados; main es "producción" del arnés.
 *   - El estado SUCIO de adapters/ y build/ en tcg — quien está iterando la migración quiere
 *     que cada arranque despliegue lo suyo, aún sin commitear. Se usa el hash del diff, no un
 *     booleano, para que un cambio nuevo re-dispare aunque ya estuviera sucio.
 *   - mtime+size de ~/.claude.json — el registro de MCPs del que traduce deploy-codex-mcp.
 *   - las integraciones y qué hooks no van por ellas (DEF-8.23-C-hooks-codex-sin-integracion, 2026-10-09): apagar o
 *     prender una integración cambia lo que se despliega sin tocar ningún repo, y sin esto `apply` o el arranque daban
 *     el despliegue por al día — Claude Code sacaba los hooks y Codex los dejaba (revisión independiente del arreglo).
 * Editar un canónico de agent-skills SIN commitear NO dispara a propósito: regenerar los .toml
 * del repo desde un canónico a medio editar es exactamente el clobber silencioso que la
 * revisión marcó; el pre-commit de tcg (build/check.js) cubre ese tramo.
 */
function fingerprint(env = process.env) {
  const claudeJson = path.join(os.homedir(), '.claude.json');
  let cj = 'ausente';
  try { const st = fs.statSync(claudeJson); cj = `${st.mtimeMs}:${st.size}`; } catch { /* ausente */ }
  // El diff se reduce a un hash: su salida cruda contiene '|' (el formato de --stat) y
  // cualquier separador elegible — lo cazó el propio selftest. Un hash corto no colisiona
  // con nada y mantiene la propiedad que importa: cambia si el diff cambia.
  const sha = (text) => require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 12);
  // un árbol que no es un repo (la versión bajada): su identidad es el `version.json` con que se publicó; nunca git. Con la
  // capa del equipo apilada (story 8.25, A2b · AC 30 f) también el commit de la capa, DENTRO de esta misma parte —la huella
  // sigue teniendo cinco—: un cambio sólo de la capa (el refresco en el lugar) redespliega sus revisores en ese arranque.
  // Sin `.tycon-team.json`, la misma cadena de antes.
  // (un refresco a medias deja su pendiente: también entra, así el arranque que lo termina vuelve a desplegar)
  const teamId = (dir) => {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, '.tycon-team.json'), 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? '' : ':t:ilegible'; }
    let pending = '';
    try { pending = `:p:${sha(fs.readFileSync(path.join(dir, '.tycon-team.pending.json')))}`; } catch { pending = ''; }
    try { const j = JSON.parse(raw); if (j && /^[0-9a-f]{40}$/.test(String(j.commit))) return `:t:${j.commit}${pending}`; } catch { /* abajo: el contenido */ }
    return `:t:${sha(raw)}${pending}`;
  };
  // …y, si su `version.json` dice que el número lo pone la etiqueta del merge (`numbering: "merge-tag"`), el commit del
  // manifiesto de la bajada (`.tycon-release.json`): ese archivo queda igual entre versiones (dice el piso) y sólo con él
  // la huella no cambiaría nunca. Sin la marca, la misma cadena de antes
  const releaseCommit = (dir) => {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'));
      if (!v || v.numbering !== 'merge-tag') return '';
      const m = JSON.parse(fs.readFileSync(path.join(dir, '.tycon-release.json'), 'utf8'));
      return m && /^[0-9a-f]{40}$/.test(String(m.commit)) ? `:c:${m.commit}` : '';
    } catch { return ''; }
  };
  const treeId = (dir) => {
    if (isRepo(dir)) return git(dir, 'rev-parse', 'HEAD') || 'sin-git';
    try { return `v:${sha(fs.readFileSync(path.join(dir, 'version.json')))}${releaseCommit(dir)}${teamId(dir)}`; } catch { return 'sin-version'; }
  };
  const dirty = isRepo(TCG) ? (git(TCG, 'diff', '--stat', 'HEAD', '--', 'adapters', 'build') || 'limpio') : 'limpio';
  // la decisión, leída con la misma función que despliega; si no se pudo tomar, el motivo entra a la huella (cambia si
  // cambia) en vez de una constante que la congelaría
  let integ;
  try {
    const dh = require(path.join(BUILD, 'deploy-codex-hooks.js'));
    const act = dh.activeFragment(JSON.parse(fs.readFileSync(dh.FRAGMENT, 'utf8')), { env });
    integ = JSON.stringify({ i: act.integrations || null, d: act.dropped.map((x) => `${x.event}:${x.spec}`), a: act.aviso || null });
  } catch (e) { integ = `error:${(e && e.message) || e}`; }
  return [
    treeId(TCG),
    treeId(SKILLS_REPO),
    sha(dirty),
    cj,
    sha(integ),
  ].join('|');
}

/** Las salidas mínimas que prueban que ALGUNA VEZ se desplegó. Si falta una, se fuerza. */
function outputsPresent() {
  try {
    if (!fs.existsSync(path.join(CODEX_HOME, 'hooks.json'))) return false;
    const skills = path.join(CODEX_HOME, 'skills');
    if (!fs.existsSync(skills) || fs.readdirSync(skills).length === 0) return false;
    if (!fs.readdirSync(CODEX_HOME).some((f) => f.endsWith('.config.toml'))) return false;
    // config.toml (los servidores MCP y writable_roots) también es salida: sin él, `apply`/`startup` daban el despliegue
    // por «al día» y nunca lo reponían (pase adversarial de la C, clase 2)
    if (!fs.existsSync(path.join(CODEX_HOME, 'config.toml'))) return false;
    return true;
  } catch { return false; }
}

function readStamp() {
  try { return JSON.parse(fs.readFileSync(STAMP, 'utf8')).fingerprint || null; } catch { return null; }
}

function writeStamp(fp) {
  try {
    fs.mkdirSync(path.dirname(STAMP), { recursive: true });
    fs.writeFileSync(STAMP, JSON.stringify({ fingerprint: fp, at: new Date().toISOString() }) + '\n');
  } catch { /* sin stamp se re-corre el próximo arranque: más caro, nunca incorrecto */ }
}

/** Decisión pura, para el selftest: ¿hay que correr los deployers? */
function shouldRun(fpNow, fpStamped, present, force) {
  if (force) return { run: true, motivo: 'forzado' };
  if (!present) return { run: true, motivo: 'salidas ausentes en CODEX_HOME (primer deploy o instalación rota)' };
  if (fpNow !== fpStamped) return { run: true, motivo: 'los insumos cambiaron desde el último deploy' };
  return { run: false, motivo: 'al día' };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();
  const CHECK = argv.includes('--check');
  const FORCE = argv.includes('--force');

  // Clon incompleto: UNA línea que dice la verdad, no cuatro que mienten.
  const faltantes = STEPS.filter((s) => !fs.existsSync(path.join(BUILD, s.script)));
  if (faltantes.length) {
    console.log(`⚠ tycon/codex: build/ incompleto en el clon (${faltantes.map((s) => s.script).join(', ')}) — ¿falló el git pull del SessionStart? Deploy salteado.`);
    return 0;
  }

  // Desde una copia temporal no se toca el Codex de la máquina (ver enCarpetaTemporal en
  // deploy-codex-hooks.js): sus hooks apuntarían a una carpeta que se borra sola, y el sello
  // quedaría con la huella de la copia. Se permite si el destino también es temporal (pruebas).
  const { enCarpetaTemporal } = require(path.join(BUILD, 'deploy-codex-hooks.js'));
  if (enCarpetaTemporal(TCG) && !enCarpetaTemporal(CODEX_HOME)) {
    if (!CHECK) console.log(`⚠ tycon/codex: el arnés corre desde una copia temporal (${TCG}) — no se toca la configuración de Codex de la máquina. Deploy salteado.`);
    return 0;
  }

  const fp = fingerprint();
  const decision = shouldRun(fp, readStamp(), outputsPresent(), FORCE);

  if (CHECK) {
    console.log(decision.run
      ? `tycon/codex --check: deploy PENDIENTE (${decision.motivo}) — se aplica en el próximo arranque sin --check`
      : 'tycon/codex --check: despliegue al día');
    return 0;
  }
  if (!decision.run) return 0; // el estado estable es silencio

  let fallo = false;
  const avisos = [];
  for (const s of STEPS) {
    const cmd = path.join(BUILD, s.script);
    let out = '';
    try {
      out = execFileSync(process.execPath, [cmd, ...s.args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
      });
    } catch (e) {
      fallo = true;
      const cola = `${e.stdout || ''}\n${e.stderr || ''}`.trim().split('\n').slice(-5).join('\n   ');
      console.log(`⚠ tycon/codex: ${s.name} falló — ${s.que}`);
      console.log(`   Diagnóstico: node ${cmd}${s.args.length ? ' ' + s.args.join(' ') : ''}`);
      if (cola) console.log(`   ${cola}`);
      continue;
    }
    // Del stdout de un paso exitoso solo sobrevive lo ACCIONABLE.
    for (const line of out.split('\n')) {
      if (/TRUST|🛑|⚠/.test(line)) avisos.push(line);
    }
    if (s.script === 'generate.js' && /📝 generado:/.test(out)) {
      avisos.push('📝 tycon/codex: el canónico cambió y los adapters del repo se regeneraron — hay .toml sin commitear en adapters/codex/ (commitealos, o avisale al autor del canónico que los olvidó)');
    }
  }

  for (const a of avisos) console.log(a);
  if (!fallo) {
    console.log('✓ tycon/codex: despliegue actualizado');
    writeStamp(fp);
    return 0;
  }
  // Sin stamp: se reintenta (y se re-anuncia) en el próximo arranque. Un deploy roto que
  // persiste tiene que seguir sonando — callarlo al segundo día es cómo se pierde una máquina.
  return 1;
}

function selftest() {
  const checks = [
    ['sin salidas presentes → corre (self-heal)', shouldRun('a', 'a', false, false).run === true],
    ['fingerprint distinto → corre', shouldRun('a', 'b', true, false).run === true],
    ['todo igual → NO corre (silencio)', shouldRun('a', 'a', true, false).run === false],
    ['--force → corre aunque esté al día', shouldRun('a', 'a', true, true).run === true],
    ['el fingerprint es estable en el mismo estado', fingerprint() === fingerprint()],
    ['el fingerprint incluye los 5 insumos', fingerprint().split('|').length === 5],
    // apagar una integración sin tocar ningún repo cambia la huella (DEF-8.23-C-hooks-codex-sin-integracion)
    ['apagar una integración cambia el fingerprint', fingerprint({ ...process.env, TYCON_NIGHTLY: '1' }) !== fingerprint({ ...process.env, TYCON_NIGHTLY: '0' })],
  ];
  let bad = 0;
  for (const [n, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-deploy-all: ${n}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ selftest-deploy-all: ${checks.length}/${checks.length} verdes`);
  return bad ? 1 : 0;
}

module.exports = { fingerprint, shouldRun, outputsPresent };
if (require.main === module) process.exit(main());
