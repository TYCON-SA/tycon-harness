'use strict';
/**
 * scripts/lib/harness-parity.js — la paridad de INSTALACIÓN Claude↔Codex.
 *
 * Responde una sola pregunta, medible: **¿el lado Codex de ESTA máquina refleja lo que el
 * canónico dice que debería haber?** Once superficies de estado de disco — acá se prueba la
 * INSTALACIÓN; el runtime lo prueba el controls-bench con sesiones reales. Nunca se envuelve
 * en `codex exec`.
 *
 * Se invoca como `node scripts/lib/harness-audit.js --parity` (o este archivo directo; `--selftest`
 * corre su red rápida). El reporte va a `.bench/harness-parity.json` y lo cobra
 * `bench-notice.js` al arranque siguiente — el rojo llega solo.
 *
 * 🔴 Las reglas, con su porqué:
 *   1. **La política vive en el DEPLOYER y se importa** (resolveServers, writableRootsHas,
 *      serverRegistered, deployPairs, substitute, linkState). Las copias a mano divergen.
 *   2. **Predicados con alcance y por ESTRUCTURA, no substrings ni prosa** — la ruta en un
 *      comentario compraría un verde; un header comentado registraría un server; un chequeo por
 *      frases en castellano necesitaría un parche de conjugación.
 *   3. **Nunca un rojo que el dev no pueda limpiar.** Skill propio del dev, agente personal en
 *      ~/.claude/agents, llave activa vía fish/direnv, formato interno de codex que cambió:
 *      todo eso es respetado o declarado, no rojo — un rojo inarreglable termina en opt-out
 *      del control entero, llevándose los rojos verdaderos.
 *   4. **Un crash es un ROJO con causa y el reporte se escribe SIEMPRE** — incluido el crash
 *      al CARGAR la política (por eso los require de deployers son lazy y guardados: un
 *      equivalences.json a medio mergear mataría el módulo antes de toda garantía).
 *   5. **Un fallo de ejecución no es verde** (spawn con error/timeout ≠ "al día").
 *
 * DISPARADOR: la EVIDENCIA de despliegue en CODEX_HOME, no la llave TYCON_CODEX. Es
 * deliberadamente más laxo que `outputsPresent()` de deploy-codex-all (ANY vs ALL: esto decide
 * "¿hay algo que auditar?", aquél "¿está completo para saltear el deploy?") — diferencia
 * documentada, no drift.
 *
 * La superficie 11 (deployers-cubiertos) cubre la instalación como lo hace el controls-bench con el runtime, y su mapa se
 * VALIDA contra las superficies reales: agregarle una entrada de prosa no lo satisface.
 * Red end-to-end: scripts/tests/harness-parity.test.sh (diaria, con laboratorio propio vía
 * TYCON_PARITY_BENCH_DIR — no toca el reporte real).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TCG = path.resolve(__dirname, '..', '..');
const HOME = os.homedir();
const CODEX = () => process.env.CODEX_HOME || path.join(HOME, '.codex');
/**
 * Dónde va el reporte: la variable explícita gana; en una versión BAJADA (el árbol trae su
 * manifiesto `.tycon-release.json`) el árbol es de sólo lectura para la máquina —escribir adentro lo dejaría «de más» para
 * `doctor` y la próxima actualización lo perdería— y el reporte va a la carpeta
 * del estado; en un clon, donde siempre (`.bench/` del árbol, que git ignora). La misma función la usa quien cobra el
 * rojo (bench-notice.js): un solo lugar decide.
 */
const BENCH_DIR = () => {
  if (process.env.TYCON_PARITY_BENCH_DIR) return process.env.TYCON_PARITY_BENCH_DIR;
  if (fs.existsSync(path.join(TCG, '.tycon-release.json'))) {
    // sin la pieza (una copia suelta): donde siempre. Cualquier OTRO error de la pieza sube: callarlo dejaría el reporte
    // adentro del árbol bajado, que es justo lo que este lugar evita (una TYCON_HOME
    // relativa NO es uno de esos errores: `stateDir(home)` la ignora y usa la casa)
    try { return path.join(require(path.join(TCG, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(HOME), 'controls-bench'); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  return path.join(TCG, 'scripts', 'controls-bench', '.bench');
};
const reportPath = () => path.join(BENCH_DIR(), 'harness-parity.json');
/** La cadencia esperada del reporte: lo exportamos para que el consumidor (bench-notice) no
 *  tenga el umbral como número mágico propio. */
const STALE_MS = 3 * 24 * 60 * 60 * 1000;

const rd = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
const rds = (p) => { const b = rd(p); return b === null ? null : String(b); };
const ls = (p) => { try { return fs.readdirSync(p); } catch { return []; } };

function codexDeployed() {
  const c = CODEX();
  if (fs.existsSync(path.join(c, 'hooks.json'))) return true;
  return ls(c).some((f) => f.endsWith('.config.toml'));
}

/**
 * La política de los deployers, cargada LAZY y guardada: en máquinas sin lado Codex nunca se
 * paga, y un módulo de política roto (equivalences a medio pull) es un rojo reportado, no un
 * crash sin reporte.
 */
function loadPolicy(errores) {
  const pol = {};
  for (const [k, rel] of [['mcp', 'deploy-codex-mcp.js'], ['hooks', 'deploy-codex-hooks.js'], ['gen', 'generate.js'], ['skills', 'deploy-shared-skills.js']]) {
    try { pol[k] = require(path.join(TCG, 'build', rel)); }
    catch (e) { pol[k] = null; errores.push(`no pude cargar la política de ${rel}: ${e.message}`); }
  }
  // la misma variante que usan los desplegadores (la «instalada»): si no, la auditoría y el despliegue miran árboles distintos
  try { pol.skillsDirs = require(path.join(TCG, 'scripts', 'lib', 'skills-dir.js')).resolveInstalledSkillsDirs(); }
  catch (e) { pol.skillsDirs = null; errores.push(`skills-dir.js: ${e.message}`); }
  return pol;
}

/**
 * Qué herramientas enchufa esta máquina: lo que dice el ESTADO del mecanismo de instalación
 * (`tools`), o —en una máquina sin mecanismo— lo de siempre: Claude Code, y Codex si su lado
 * está desplegado. `recorded` dice cuál de las dos fue. La paridad mide sobre esto: una máquina que sólo enchufa a Codex
 * no puede dar rojo por piezas de Claude Code que no tiene.
 */
function pluggedTools() {
  try {
    const TH = require(path.join(TCG, 'scripts', 'setup', 'harness', 'tycon-home.js'));
    const s = JSON.parse(fs.readFileSync(path.join(TH.stateDir(HOME), 'harness-state.json'), 'utf8'));
    const t = s && Array.isArray(s.tools) ? ['claude', 'codex'].filter((x) => s.tools.includes(x)) : [];
    if (t.length) return { tools: t, recorded: true };
  } catch { /* sin estado, o ilegible: lo de siempre */ }
  return { tools: codexDeployed() ? ['claude', 'codex'] : ['claude'], recorded: false };
}

function buildCtx(plugged = pluggedTools()) {
  const ctx = { toml: rds(path.join(CODEX(), 'config.toml')) || '', errores: [], tools: plugged.tools, recorded: plugged.recorded };
  const withClaude = ctx.tools.includes('claude');
  ctx.pol = loadPolicy(ctx.errores);
  try { ctx.hooksDeployed = JSON.parse(rds(path.join(CODEX(), 'hooks.json')) || '{"hooks":{}}').hooks || {}; }
  catch (e) { ctx.hooksDeployed = {}; ctx.errores.push(`hooks.json ilegible: ${e.message}`); }
  // el registro de Claude Code de la máquina: el desplegador lo toma si está (sus servidores se suman). Roto es un rojo
  // sólo donde Claude Code está enchufado; en una máquina sólo con Codex no es una pieza suya (el desplegador lo saltea)
  try { ctx.claudeCfg = JSON.parse(rds(path.join(HOME, '.claude.json')) || '{}'); }
  catch (e) { ctx.claudeCfg = {}; if (withClaude) ctx.errores.push(`~/.claude.json ilegible: ${e.message}`); }
  try { ctx.eq = JSON.parse(rds(path.join(TCG, 'build', 'equivalences.json')) || '{}'); }
  catch (e) { ctx.eq = {}; ctx.errores.push(`equivalences.json ilegible: ${e.message}`); }
  try { ctx.manifest = JSON.parse(rds(path.join(TCG, 'adapters', 'codex', 'agents', 'MANIFEST.json')) || '{"advisors":[]}').advisors || []; }
  catch (e) { ctx.manifest = null; ctx.errores.push(`MANIFEST.json ilegible: ${e.message}`); }
  return ctx;
}

// ── Las 11 superficies ────────────────────────────────────────────────────────────────────────

function sAdvisors(ctx) {
  if (!ctx.pol.gen) return { name: 'advisors', ok: false, detail: 'política de generate.js no cargada' };
  if (!ctx.manifest || ctx.manifest.length === 0) {
    return { name: 'advisors', ok: false, detail: 'MANIFEST.json vacío o ilegible — nada que comparar no es un verde' };
  }
  let stale = 0, missing = 0;
  // lo desplegado lleva el modelo resuelto de la organización: se compara con la misma resolución que el
  // despliegue (orgCodexModel + deployedContent); un generador que no la tiene se compara como siempre
  const conOrg = typeof ctx.pol.gen.orgCodexModel === 'function' && typeof ctx.pol.gen.deployedContent === 'function';
  const esperado = (n, buf) => (conOrg ? Buffer.from(ctx.pol.gen.deployedContent(buf.toString('utf8'), ctx.pol.gen.orgCodexModel(TCG, n))) : buf);
  for (const n of ctx.manifest) {
    for (const par of ctx.pol.gen.deployPairs(n, CODEX())) {
      const a = rd(par.outPath);
      const b = rd(par.deployTo);
      if (!a) continue;                    // adapter ausente lo caza build/check.js
      if (!b) { missing++; continue; }
      if (Buffer.compare(esperado(n, a), b) !== 0) stale++;
    }
  }
  // Los revisores de la capa del equipo: no hay adapters/ con qué compararlos —la máquina los
  // genera—, así que se comparan contra lo que el generador escribiría AHORA (la misma lista y la misma función que el
  // despliegue: advisorsToDeploy y generateOne). Uno que falta o difiere es rojo, con quién lo arregla: ese rojo no lo
  // limpia el dev con un comando suyo.
  const teamNames = [];
  const teamDetail = [];
  let teamBroken = null;
  const layerHere = fs.existsSync(path.join(TCG, '.tycon-team.json'));
  if (typeof ctx.pol.gen.advisorsToDeploy !== 'function') {
    // un generador que no sabe de la capa no es «capa al día»: con capa en el árbol, no se puede medir y es rojo
    if (layerHere) teamBroken = 'el generador de esta versión no sabe desplegar la capa del equipo (sin advisorsToDeploy): lo arregla una versión nueva';
  } else {
    let set = null;
    try { set = ctx.pol.gen.advisorsToDeploy(TCG); } catch (e) { teamBroken = e.message; }
    if (set && set.team === null) teamBroken = set.teamProblem;
    if (set && Array.isArray(set.team)) teamNames.push(...set.team);
    let rec = null;
    try { const T = require(path.join(TCG, 'scripts', 'setup', 'harness', 'tools.js')); rec = T.readCodexTeamRecord(T.codexTeamRecordPath({ home: HOME })); } catch (e) { teamBroken = teamBroken || `no pude leer el registro de la capa en Codex (${e.message})`; }
    // un registro ilegible: sin él no se sabe qué archivo es del arnés; se dice ESO, no «archivo tuyo»
    if (rec && rec.problem && teamNames.length) { teamBroken = teamBroken || `el registro de los revisores de la capa no se lee (${rec.problem}): borralo y corré deploy-codex-all.js --force`; rec = null; }
    for (const n of teamNames) {
      let g;
      try { g = ctx.pol.gen.generateOne(TCG, n, { agentsDir: (set.teamDirs || {})[n] || null }); } catch (e) { missing += 2; teamDetail.push(`${n} no se puede generar (${String(e.message).slice(0, 120)}): lo arregla el repo del equipo o la versión`); continue; }
      for (const [rel, content] of [[`${n}.config.toml`, esperado(n, Buffer.from(g.toml))], [`agents/${n}.toml`, esperado(n, Buffer.from(g.nativeToml))]]) {
        const have = rd(path.join(CODEX(), ...rel.split('/')));
        if (!have) { missing++; teamDetail.push(`${rel} falta: lo arregla el repo del equipo o la versión (o deploy-codex-all.js --force)`); continue; }
        if (Buffer.compare(have, Buffer.from(content)) === 0) continue;
        if (!rec) { stale++; teamDetail.push(`${rel} difiere (sin registro legible no se sabe de quién es)`); }
        else if (rec.files[rel]) { stale++; teamDetail.push(`${rel} difiere: editado a mano: deploy-codex-all.js --force`); }
        else { missing++; teamDetail.push(`${rel} es un archivo tuyo con el nombre de un revisor de la capa: renombralo o borralo`); }
      }
    }
  }
  // Un .md en ~/.claude/agents que no está en el manifest puede ser un agente PERSONAL del dev
  // (uso documentado de esa carpeta): se INFORMA, jamás es rojo — migrarlo exigiría meterlo al
  // manifest del equipo con casos, que no es una remediación del dev.
  // (sólo donde Claude Code está enchufado: en una máquina sólo con Codex esa carpeta no es de nadie)
  // Los de la capa del equipo no son personales: no van en esa nota (se miden arriba).
  const canon = ctx.tools && !ctx.tools.includes('claude') ? [] : ls(path.join(HOME, '.claude', 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  const sinMigrar = canon.filter((a) => !ctx.manifest.includes(a) && !teamNames.includes(a));
  const nota = sinMigrar.length ? ` · ${sinMigrar.length} .md fuera del manifest (¿personales?): ${sinMigrar.slice(0, 3).join(', ')}` : '';
  const ok = missing === 0 && stale === 0 && !teamBroken;
  const capa = teamNames.length ? ` (${teamNames.length} de la capa del equipo)` : '';
  const why = [teamBroken ? `la lista de la capa del equipo no se lee: ${teamBroken}` : null, ...teamDetail.slice(0, 2)].filter(Boolean);
  return { name: 'advisors', ok, detail: (ok ? `${ctx.manifest.length + teamNames.length} desplegados al día${capa}` : `faltan ${missing} · viejos ${stale}${why.length ? ` — ${why.join(' · ')}` : ''}`) + nota };
}

function sHooks(ctx) {
  if (!ctx.pol.hooks) return { name: 'hooks', ok: false, detail: 'política de deploy-codex-hooks no cargada' };
  const fragRaw = rds(ctx.pol.hooks.FRAGMENT);
  if (!fragRaw) return { name: 'hooks', ok: false, detail: 'adapters/codex/hooks.json ilegible' };
  // lo esperado es lo que esta máquina registra: sin los hooks de una integración apagada, con la MISMA decisión que el
  // desplegador. Un desplegador sin la función: el fragmento entero.
  const raw = JSON.parse(fragRaw);
  const act = typeof ctx.pol.hooks.activeFragment === 'function' ? ctx.pol.hooks.activeFragment(raw) : { fragment: raw, dropped: [] };
  const esperado = ctx.pol.hooks.substitute(act.fragment.hooks, TCG, ctx.pol.hooks.SKILLS);
  // Comando COMPLETO + multiconjunto: el basename sería ciego al path y a los duplicados.
  const flat = (h) => {
    const o = [];
    for (const [e, gs] of Object.entries(h || {})) for (const g of gs) for (const x of (g.hooks || [])) o.push(`${e}|${g.matcher || '*'}|${x.command}`);
    return o.sort();
  };
  const esp = flat(esperado);
  // Un hook desplegado que todavía apunta a la ruta vieja de un archivo renombrado corre el nuevo a través de su
  // reemplazo: cuenta como el nuevo. Lo reescribe el instalador (--migrate-machine); mientras tanto no es un rojo.
  let resolver = (x) => x;
  try { const ln = require(path.join(TCG, 'scripts', 'lib', 'legacy-names.js')); resolver = (x) => ln.resolveShimsInCommand(x); } catch { /* sin la biblioteca, como antes */ }
  const pool = flat(ctx.hooksDeployed).map(resolver);
  const faltan = [];
  for (const k of esp) {
    const i = pool.indexOf(k);
    if (i >= 0) pool.splice(i, 1); else faltan.push(k);
  }
  const offNote = act.dropped.length ? ` · ${act.dropped.length} sin registrar por su integración apagada` : '';
  return { name: 'hooks', ok: faltan.length === 0, detail: (faltan.length ? `faltan ${faltan.length}: ${faltan.slice(0, 2).map((k) => k.split('|')[2].split('/').pop()).join(' · ')}` : `${esp.length} registrados`) + offNote };
}

function sSkills(ctx) {
  if (!ctx.pol.skills || !ctx.pol.skillsDirs) return { name: 'skills', ok: false, detail: 'política de deploy-shared-skills no cargada' };
  const clone = ctx.pol.skillsDirs.skills;
  const reales = ls(clone).filter((d) => {
    try { return fs.statSync(path.join(clone, d)).isDirectory() && fs.existsSync(path.join(clone, d, 'SKILL.md')); } catch { return false; }
  });
  if (reales.length === 0) return { name: 'skills', ok: false, detail: `el clon de skills está vacío o ilegible (${clone})` };
  const conteo = { ausente: [], roto: [], dev: 0, ok: 0 };
  // las de los paquetes que la organización activa: el deployer las enlaza aparte (packSkills), cada una
  // desde la carpeta de skills de su paquete — la paridad las mira igual
  // (si no se pueden leer, no es «no hay»: se dice)
  let dePaquetes = [];
  try { const ps = ctx.pol.skills.packSkills ? ctx.pol.skills.packSkills(path.dirname(clone)) : null; dePaquetes = ps ? ps.extra : []; } catch (e) {
    return { name: 'skills', ok: false, detail: `no pude leer las skills de los paquetes (${String(e.message).split('\n')[0]})` };
  }
  const todas = [...reales.map((s) => ({ name: s, src: clone })), ...dePaquetes.map((x) => ({ name: x.name, src: path.dirname(x.src) }))];
  for (const { name: s, src } of todas) {
    // La MISMA clasificación que usa el deployer (linkState exportado): lo del dev jamás es
    // rojo; lo nuestro roto es remediable (el próximo deploy lo limpia y re-crea).
    const estado = ctx.pol.skills.linkState(path.join(CODEX(), 'skills', s), src, s);
    if (estado === 'ausente') conteo.ausente.push(s);
    else if (estado === 'roto') conteo.roto.push(s);
    else if (estado === 'dev') conteo.dev++;
    else conteo.ok++;
  }
  const ok = conteo.ausente.length === 0 && conteo.roto.length === 0;
  const dev = conteo.dev ? ` · ${conteo.dev} del dev (respetadas)` : '';
  return { name: 'skills', ok, detail: ok ? `${conteo.ok} linkeadas${dev}` : `faltan ${conteo.ausente.length} · rotas ${conteo.roto.length} (${[...conteo.ausente, ...conteo.roto].slice(0, 3).join(', ')})${dev}` };
}

function sMcp(ctx) {
  if (!ctx.pol.mcp) return { name: 'mcp', ok: false, detail: 'política de deploy-codex-mcp no cargada' };
  let intended;
  try { intended = Object.keys(ctx.pol.mcp.resolveServers(ctx.claudeCfg, ctx.eq).servers); }
  catch (e) { return { name: 'mcp', ok: false, detail: `no pude computar el intent del deployer: ${e.message}` }; }
  const faltan = intended.filter((l) => !ctx.pol.mcp.serverRegistered(ctx.toml, l));
  return { name: 'mcp', ok: faltan.length === 0, detail: faltan.length ? `el deployer registraría ${intended.length} y faltan: ${faltan.join(', ')}` : `${intended.length} servers según el intent del deployer` };
}

function sAgentsMd() {
  if (process.env.TYCON_NO_CLAUDEMD_SYNC === '1') return { name: 'agents-md', ok: true, detail: 'sync opt-out (TYCON_NO_CLAUDEMD_SYNC=1) — sin reglas que auditar' };
  // AGENTS.md no es copia del CLAUDE.md: lleva los bloques del arnés entre sus marcas,
  // escritos por agents-md-blocks.js. Se mide con ESE escritor en modo `check` (la política vive en quien escribe): así
  // una máquina sólo con Codex no depende de un CLAUDE.md que no tiene, y lo que la persona escribe fuera de las marcas
  // no cuenta como diferencia.
  const lib = path.join(TCG, 'scripts', 'setup', 'agents-md-blocks.js');
  if (!fs.existsSync(lib)) return { name: 'agents-md', ok: false, detail: 'scripts/setup/agents-md-blocks.js ausente' };
  let r;
  try { r = require(lib).sync({ check: true, quiet: true, home: HOME, env: Object.assign({}, process.env, { TYCON_PLAN_PIECES: '' }) }); }
  catch (e) { return { name: 'agents-md', ok: false, detail: `no pude verificar las reglas de AGENTS.md: ${e.message}` }; }
  if (!r.ok) return { name: 'agents-md', ok: false, detail: `no pude verificar las reglas de AGENTS.md: ${r.reason}` };
  if (r.pending) return { name: 'agents-md', ok: false, detail: (r.lines.find((l) => /desactualizado|sobra|sin marca de cierre/.test(l)) || 'AGENTS.md no trae los bloques del arnés al día — corré node scripts/setup/agents-md-blocks.js').replace(/^⚠ tycon: /, '') };
  return { name: 'agents-md', ok: true, detail: `AGENTS.md con los ${r.present.length} bloques del arnés al día` };
}

function sTablaVsRealidad(ctx) {
  if (!ctx.pol.mcp) return { name: 'tabla-vs-realidad', ok: false, detail: 'política de deploy-codex-mcp no cargada' };
  const tabla = rds(path.join(TCG, 'claude-md-blocks', 'names', 'tool-names.codex.md')) || '';
  // Conjuntos por los nombres mcp__<server>__ (estructura), no prosa.
  const registrados = ctx.pol.mcp.OWN_LABELS.filter((l) => ctx.pol.mcp.serverRegistered(ctx.toml, l));
  const mencionados = new Set([...tabla.matchAll(/mcp__([a-z0-9_]+)__/gi)].map((m) => m[1]));
  const ocultos = registrados.filter((l) => !mencionados.has(l));
  const fantasma = [...mencionados].filter((l) => ctx.pol.mcp.OWN_LABELS.includes(l) && !ctx.pol.mcp.serverRegistered(ctx.toml, l))
    .filter((l) => {
      const fila = tabla.split('\n').find((ln) => ln.includes(`mcp__${l}__`)) || '';
      return !/s[oó]lo si/i.test(fila);   // una fila condicional declara su propia ausencia
    });
  const problemas = [];
  if (ocultos.length) problemas.push(`servers registrados que la tabla no nombra (apaga sus reglas): ${ocultos.join(', ')}`);
  if (fantasma.length) problemas.push(`la tabla promete tools de servers NO registrados (sin marcarlos condicionales): ${fantasma.join(', ')}`);
  return { name: 'tabla-vs-realidad', ok: problemas.length === 0, detail: problemas.join(' · ') || `tabla consistente con ${registrados.length} servers registrados` };
}

function sCodexCli() {
  const bin = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { stdio: 'ignore' }).status === 0;
  if (!bin) return { name: 'codex-cli', ok: false, detail: 'el binario `codex` no está en el PATH' };
  const auth = fs.existsSync(path.join(CODEX(), 'auth.json'));
  return { name: 'codex-cli', ok: auth, detail: auth ? 'binario + login' : 'binario ok pero SIN login (correr: codex login)' };
}

function sLlaveEnRc(ctx) {
  // con el mecanismo de instalación diciendo qué enchufa la máquina, el lado Codex se mantiene por
  // el ESTADO —lo re-enchufa cada actualización— y no depende de una variable del rc que el arranque no ve
  if (ctx && ctx.recorded && ctx.tools.includes('codex')) {
    return { name: 'llave-en-rc', ok: true, detail: 'el estado del arnés dice que esta máquina enchufa a Codex: su lado se mantiene sin depender de la llave' };
  }
  if (process.platform === 'win32') {
    return { name: 'llave-en-rc', ok: true, detail: 'Windows: la llave se verifica en el checklist F3 (registro de usuario), no acá' };
  }
  // Tolerante a comillas y con .zshenv (el archivo canónico de env en zsh): `export TYCON_CODEX="1"` —hábito
  // común— daría rojo permanente en una máquina sana.
  const rcs = ['.zshrc', '.zshenv', '.zprofile', '.bashrc', '.bash_profile', '.profile'].map((f) => path.join(HOME, f));
  const enRc = rcs.some((f) => /^[^#\n]*\bTYCON_CODEX\s*=\s*["']?1/m.test(rds(f) || ''));
  if (enRc) return { name: 'llave-en-rc', ok: true, detail: 'TYCON_CODEX=1 en el rc' };
  if (process.env.TYCON_CODEX === '1') {
    // Activa por un mecanismo que no leemos (fish, direnv, archivo sourceado, launchctl):
    // la máquina FUNCIONA — marcarla roja sería un rojo inarreglable (regla 3).
    return { name: 'llave-en-rc', ok: true, detail: 'llave activa por un mecanismo propio (fish/direnv/sourced) — asegurate de que persista entre sesiones' };
  }
  return { name: 'llave-en-rc', ok: false, detail: 'TYCON_CODEX=1 NO está activa ni en el rc: el lado Codex desplegado no se va a mantener' };
}

function sWritableRoots(ctx) {
  if (!ctx.pol.mcp) return { name: 'writable-roots', ok: false, detail: 'política de deploy-codex-mcp no cargada' };
  // todas las raíces que el desplegador pone: el estado vigente y la casa propia del arnés
  const roots = typeof ctx.pol.mcp.markerRoots === 'function' ? ctx.pol.mcp.markerRoots() : [ctx.pol.mcp.markerRoot()];
  const ok = roots.every((r) => ctx.pol.mcp.writableRootsHas(ctx.toml, r));
  //
  // 🔴 Que estén no alcanza: con UNA raíz que pasa por un enlace, Codex rechaza todos los comandos de shell
  //    y no avisa al arrancar. Una superficie que sólo mira que las rutas estén daría verde sin que Codex las
  //    acepte (por ejemplo, la carpeta vieja del estado que quedó como enlace y sigue en la lista). La política de
  //    qué es un enlace y de quién es cada raíz vive en el desplegador.
  if (ok && typeof ctx.pol.mcp.linkedRoots === 'function') {
    const linked = ctx.pol.mcp.linkedRoots(ctx.toml);
    if (linked.length) {
      const x = linked[0];
      const more = linked.length > 1 ? ` (y ${linked.length - 1} más)` : '';
      const fix = linked.every((l) => l.own)
        ? 'es del arnés (la carpeta vieja del estado): corré `node build/deploy-codex-mcp.js`, que la saca y deja la ruta real'
        : 'no es del arnés: cambiala por su ruta real o sacala de [sandbox_workspace_write] writable_roots en ~/.codex/config.toml';
      return { name: 'writable-roots', ok: false, detail: `la raíz ${x.root} pasa por un enlace (${x.component})${more}: con una raíz así Codex rechaza TODOS los comandos de shell y no lo dice al arrancar — ${fix}` };
    }
  }
  return { name: 'writable-roots', ok, detail: ok ? 'el estado del arnés es escribible desde el sandbox' : 'falta la ruta del arnés como ELEMENTO de [sandbox_workspace_write] writable_roots — el pipeline bajo Codex no puede escribir su marker (delta 1 de la corrida dorada)' };
}

function sTrust(ctx) {
  let total = 0;
  const posiciones = new Set();
  const norm = (e) => String(e).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [ev, gs] of Object.entries(ctx.hooksDeployed)) {
    gs.forEach((g, gi) => (g.hooks || []).forEach((_, hi) => { total++; posiciones.add(`${norm(ev)}:${gi}:${hi}`); }));
  }
  if (total === 0) return { name: 'trust', ok: true, detail: 'sin hooks desplegados' };
  const hooksPath = path.join(CODEX(), 'hooks.json');
  // Posiciones DISTINTAS cubiertas (Set, no contador): dos claves viejas que normalizan a la
  // misma posición inflarían el conteo y darían verde con un hook sin aprobar.
  const cubiertas = new Set();
  let clavesTotales = 0, clavesParseadas = 0;
  for (const m of ctx.toml.matchAll(/\[hooks\.state\."([^"]+)"\]/g)) {
    clavesTotales++;
    const clave = m[1];
    const idx = clave.lastIndexOf('.json:');
    if (idx < 0) continue;
    const archivo = clave.slice(0, idx + 5);
    const partes = clave.slice(idx + 6).split(':');
    if (partes.length !== 3) continue;
    clavesParseadas++;
    if (archivo !== hooksPath) continue;
    const pos = `${norm(partes[0])}:${partes[1]}:${partes[2]}`;
    if (posiciones.has(pos)) cubiertas.add(pos);
  }
  // El formato de la clave es INTERNO de codex: si hay claves y NINGUNA parsea, lo que cambió
  // es el formato, no las aprobaciones — decir "0 aprobados, corré /hooks" sería un rojo
  // inarreglable con remediación falsa (regla 3). Se declara la asimetría a re-sondear.
  if (clavesTotales > 0 && clavesParseadas === 0) {
    return { name: 'trust', ok: false, detail: `hay ${clavesTotales} entradas de hooks.state pero NINGUNA parsea con el formato conocido — ¿cambió codex su layout interno? Re-sondear antes de confiar en este conteo` };
  }
  const ok = cubiertas.size >= total;
  return { name: 'trust', ok, detail: ok ? `${cubiertas.size}/${total} aprobados` : `${cubiertas.size}/${total} hooks aprobados para el hooks.json actual — los no aprobados NO corren en sesiones interactivas y no dan error. Correr /hooks en una sesión de codex y aprobar` };
}

function sDeployersCubiertos() {
  // valor = superficies que lo miden ('+'-separadas), validadas contra las REALES; 'exento'
  // sólo para el orquestador, con su razón. Un mapa de prosa libre se satisface agregando una
  // entrada sin escribir la superficie.
  const CUBIERTOS = {
    'generate.js': 'advisors',
    'deploy-codex-hooks.js': 'hooks',
    'deploy-codex-mcp.js': 'mcp+writable-roots',
    'deploy-shared-skills.js': 'skills',
    'deploy-codex-all.js': 'exento:orquestador — sus pasos son los 4 de arriba',
  };
  const nombresReales = new Set(SURFACES.map((f) => NOMBRES[f.name] || f.name));
  const problemas = [];
  const build = ls(path.join(TCG, 'build')).filter((f) => f === 'generate.js' || /^deploy-.*\.js$/.test(f));
  for (const f of build) {
    const val = CUBIERTOS[f];
    if (!val) { problemas.push(`${f} SIN superficie que lo mida`); continue; }
    if (val.startsWith('exento:')) continue;
    for (const surf of val.split('+')) {
      if (!nombresReales.has(surf.trim())) problemas.push(`${f} declara la superficie "${surf.trim()}" que NO existe — el mapa no se satisface con prosa`);
    }
  }
  return { name: 'deployers-cubiertos', ok: problemas.length === 0, detail: problemas.join(' · ') || `${build.length} deployers, todos medidos por superficies reales` };
}

// ── Orquestación ──────────────────────────────────────────────────────────────────────────────

const SURFACES = [sAdvisors, sHooks, sSkills, sMcp, sAgentsMd, sTablaVsRealidad,
  sCodexCli, sLlaveEnRc, sWritableRoots, sTrust, sDeployersCubiertos];
/** nombre de función → nombre de superficie (para validar el mapa de deployers) */
const NOMBRES = { sAdvisors: 'advisors', sHooks: 'hooks', sSkills: 'skills', sMcp: 'mcp', sAgentsMd: 'agents-md', sTablaVsRealidad: 'tabla-vs-realidad', sCodexCli: 'codex-cli', sLlaveEnRc: 'llave-en-rc', sWritableRoots: 'writable-roots', sTrust: 'trust', sDeployersCubiertos: 'deployers-cubiertos' };

function collect(ctx) {
  return SURFACES.map((fn) => {
    try { return fn(ctx); }
    catch (e) { return { name: NOMBRES[fn.name] || fn.name, ok: false, detail: `la superficie CRASHEÓ: ${e.message}` }; }
  });
}

function writeReport(report) {
  try {
    fs.mkdirSync(BENCH_DIR(), { recursive: true });
    const dst = path.join(BENCH_DIR(), 'harness-parity.json');
    // Atómico (tmp+rename): el reporte tiene lectores asíncronos (bench-notice, la red diaria)
    // y una lectura a mitad de escritura se descartaría en silencio.
    const tmp = `${dst}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 1) + '\n');
    fs.renameSync(tmp, dst);
  } catch { /* sin reporte no hay cobro; el exit code igual informa al invocador directo */ }
}

function runParity(opts = {}) {
  let report;
  // se mide sobre cada herramienta ENCHUFADA: con el estado diciendo qué enchufa la máquina,
  // manda el estado —sin Codex en la lista no hay nada que medir, aunque haya quedado algo desplegado; con Codex en la
  // lista se mide aunque todavía no haya nada (y da rojo)—; sin estado que lo diga, la evidencia de despliegue, como siempre
  let plugged = { tools: ['claude'], recorded: false };
  try {
    plugged = pluggedTools();
    const measure = plugged.recorded ? plugged.tools.includes('codex') : codexDeployed();
    if (!measure) {
      report = { kind: 'harness-parity', ts: new Date().toISOString(), deployed: false, tools: plugged.tools, reds: 0, surfaces: [] };
    } else {
      const ctx = buildCtx(plugged);
      const surfaces = collect(ctx);
      for (const e of ctx.errores) surfaces.push({ name: 'insumos', ok: false, detail: e });
      report = { kind: 'harness-parity', ts: new Date().toISOString(), deployed: true, tools: plugged.tools, reds: surfaces.filter((s) => !s.ok).length, surfaces };
    }
  } catch (e) {
    report = { kind: 'harness-parity', ts: new Date().toISOString(), deployed: true, tools: plugged.tools, reds: 1, surfaces: [{ name: 'audit', ok: false, detail: `la auditoría CRASHEÓ: ${e.message}` }] };
  }
  writeReport(report);
  if (opts.json) { console.log(JSON.stringify(report, null, 1)); return report.reds ? 1 : 0; }
  if (!report.deployed) {
    console.log(plugged.recorded
      ? 'paridad Claude↔Codex: esta máquina no enchufa a Codex (lo dice el estado del arnés) — 0 superficies medibles, 0 rojos (para enchufarlo: harness.js install --tool codex).'
      : 'paridad Claude↔Codex: esta máquina NO tiene el lado Codex desplegado — 0 superficies medibles, 0 rojos (para desplegarlo: onboarding PASO 7, o TYCON_CODEX=1 + install-tycon-hooks.sh).');
    return 0;
  }
  console.log(report.tools.includes('claude')
    ? `paridad de instalación Claude↔Codex — ${report.surfaces.length} superficies · ${report.reds} en rojo`
    : `paridad de instalación de Codex (esta máquina no enchufa a Claude Code: no se le pide ninguna pieza suya) — ${report.surfaces.length} superficies · ${report.reds} en rojo`);
  for (const s of report.surfaces) console.log(` ${s.ok ? '✅' : '🔴'} ${s.name}: ${s.detail}`);
  if (report.reds) console.log('\nEl rojo se cobra solo en el próximo arranque (bench-notice). Detalle: ' + path.join(BENCH_DIR(), 'harness-parity.json'));
  return report.reds ? 1 : 0;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
  const prevCodex = process.env.CODEX_HOME;
  const prevBench = process.env.TYCON_PARITY_BENCH_DIR;
  let checks;
  try {
    process.env.CODEX_HOME = path.join(tmp, 'codex-vacio');
    process.env.TYCON_PARITY_BENCH_DIR = path.join(tmp, 'bench');   // jamás el reporte real
    const noDeploy = !codexDeployed();
    fs.mkdirSync(path.join(tmp, 'codex-vacio'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'codex-vacio', 'hooks.json'), '{"hooks":{}}');
    const siDeploy = codexDeployed();
    const ctxVacio = buildCtx();
    const trustVacio = sTrust(ctxVacio);
    const crashRojo = collect({ ...ctxVacio, hooksDeployed: null }).find((s) => s.name === 'trust');
    runParity({ json: false });
    const escrito = JSON.parse(rds(path.join(tmp, 'bench', 'harness-parity.json')) || '{}');
    checks = [
      ['sin CODEX_HOME poblado → no desplegado', noDeploy === true],
      ['con hooks.json → desplegado', siDeploy === true],
      ['trust sin hooks → verde con detalle honesto', trustVacio.ok === true],
      ['una superficie que crashea → ROJO con la causa, no auditoría muerta', Boolean(crashRojo) && crashRojo.ok === false && /CRASHE/.test(crashRojo.detail)],
      ['son 11 superficies', SURFACES.length === 11],
      ['el mapa de deployers se valida contra superficies reales', sDeployersCubiertos().ok === true],
      ['el reporte lleva kind y respeta TYCON_PARITY_BENCH_DIR', escrito.kind === 'harness-parity'],
    ];
  } finally {
    if (prevCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodex;
    if (prevBench === undefined) delete process.env.TYCON_PARITY_BENCH_DIR; else process.env.TYCON_PARITY_BENCH_DIR = prevBench;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  let bad = 0;
  for (const [n, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-parity: ${n}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ selftest-parity: ${checks.length}/${checks.length} verdes`);
  return bad ? 1 : 0;
}

module.exports = { runParity, collect, buildCtx, codexDeployed, selftest, STALE_MS, reportPath, benchDir: BENCH_DIR, sSkills };

if (require.main === module) {
  // `--report-path`: dónde escribiría el reporte esta máquina, sin medir nada (lo prueba harness-parity.test.sh)
  if (process.argv.includes('--report-path')) { process.stdout.write(reportPath()); process.exit(0); }
  process.exit(process.argv.includes('--selftest') ? selftest() : runParity({ json: process.argv.includes('--json') }));
}
