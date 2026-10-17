'use strict';

/**
 * pack-pieces.js — qué piezas trae cada paquete (skills, agentes, guías) y cuáles activa la organización.
 *
 * Un paquete vive en `packs/<nombre>/` del árbol del arnés. Su `pack.json` puede declarar `skills` y `agents`: carpetas
 * DEL PAQUETE con sus skills y sus agentes. Lo que se enlaza en la máquina (`~/.claude/skills`, `~/.claude/agents`, y
 * `~/.codex/skills` con Codex) sigue a lo que activa la organización con `packs.default` (`all`, `none` o una lista), la
 * clave que lee scripts/lib/tycon-config.js. Lo leen el aplicador (canonical-path.js), el despliegue de Codex, el doctor y
 * la desinstalación.
 *
 * Es un lector liviano: no valida condiciones ni revisores (eso es skills/tycon-pipeline/scripts/lib/packs.js). Sí frena
 * lo que haría enlazar algo equivocado: una carpeta declarada que no existe o sale del paquete, y un agente con el mismo
 * nombre en el paquete y en la raíz. Nunca tira: devuelve `errores` con archivo y motivo.
 */

const fs = require('fs');
const path = require('path');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
const entries = (d) => { try { return fs.readdirSync(d).filter((n) => !n.startsWith('.')).sort(); } catch (_) { return []; } };

/** La carpeta de paquetes de un árbol. */
const packsDirOf = (tree) => path.join(tree, 'packs');

/** null si `rel` es una ruta relativa al árbol que no sale de él; si no, el motivo (la regla de `guides` del manifiesto). */
function guideProblem(rel) {
  if (typeof rel !== 'string' || !rel.trim()) return 'tiene que ser una ruta (texto)';
  if (path.isAbsolute(rel) || rel.includes('\\') || rel.split('/').some((t) => t === '..' || t === '')) return `«${rel}» tiene que ser relativa al árbol del arnés, sin «..» ni tramos vacíos`;
  return null;
}

/** null si `rel` es una carpeta que existe adentro de `dir`; si no, el motivo. */
function folderProblem(rel, dir) {
  if (typeof rel !== 'string' || !rel.trim()) return 'tiene que ser la ruta de una carpeta del paquete (texto)';
  if (path.isAbsolute(rel) || rel.includes('\\') || rel.split('/').some((t) => t === '..' || t === '')) return `«${rel}» tiene que ser relativa a la carpeta del paquete, sin «..» ni tramos vacíos`;
  return isDir(path.join(dir, rel)) ? null : `la carpeta ${path.join(dir, rel)} no existe`;
}

/**
 * Los paquetes instalados: `{ packs: [{ name, dir, file, skillsDir, agentsDir, guides }], errores }`. Una carpeta de
 * paquetes que no existe es cero paquetes (un árbol sin paquetes).
 */
function listPacks(packsDir) {
  const out = { packs: [], errores: [] };
  for (const name of entries(packsDir)) {
    const dir = path.join(packsDir, name);
    const file = path.join(dir, 'pack.json');
    if (!isDir(dir) || !fs.existsSync(file)) continue;
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { out.errores.push({ archivo: file, motivo: `JSON inválido o ilegible: ${e.message}` }); continue; }
    const p = { name, dir, file, skillsDir: null, agentsDir: null, guides: [] };
    let roto = false;
    // las guías: rutas relativas al árbol, sin salir de él (quien las lee las une con la raíz)
    for (const g of Array.isArray(json && json.guides) ? json.guides : []) {
      const m = guideProblem(g);
      if (m) { out.errores.push({ archivo: file, motivo: `«guides»: ${m}` }); roto = true; } else p.guides.push(g);
    }
    for (const [clave, campo] of [['skills', 'skillsDir'], ['agents', 'agentsDir']]) {
      if (!json || json[clave] == null) continue;
      const m = folderProblem(json[clave], dir);
      if (m) { out.errores.push({ archivo: file, motivo: `«${clave}»: ${m}` }); roto = true; } else p[campo] = path.join(dir, json[clave]);
    }
    if (!roto) out.packs.push(p);
  }
  return out;
}

/**
 * Las piezas de los paquetes `names`: `{ skills: [{ pack, name, src }], agents: [...], guides: [{ pack, path }], errores }`.
 * Cada skill es una carpeta con su SKILL.md; cada agente, un `.md`. Un agente con el mismo nombre en `agentsDir` (la
 * raíz) es un error y no se devuelve.
 */
function piecesOf({ packsDir, agentsDir = null, coreSkillsDir = null, names }) {
  const { packs, errores } = listPacks(packsDir);
  const out = { skills: [], agents: [], guides: [], errores: errores.slice() };
  const coreSkills = coreSkillsDir || path.join(path.dirname(packsDir), 'skills');
  // cada nombre se enlaza en un solo lugar de ~/.claude: el mismo nombre en el núcleo o en dos paquetes activos se dice, y
  // queda la primera (los paquetes van por orden de nombre); la que choca con el núcleo, ninguna
  const seen = { skills: new Map(), agents: new Map() };
  const take = (side, p, n, src, inCore, coreWhere) => {
    if (inCore) { out.errores.push({ archivo: p.file, motivo: `${side === 'skills' ? 'la skill' : 'el agente'} ${n} está en dos lugares (${src} y en el núcleo, ${coreWhere}): va en uno solo` }); return; }
    const first = seen[side].get(n);
    if (first) { out.errores.push({ archivo: p.file, motivo: `${side === 'skills' ? 'la skill' : 'el agente'} ${n} está en dos paquetes activos (${first} y ${p.name}): se enlaza la de ${first}` }); return; }
    seen[side].set(n, p.name);
    out[side].push({ pack: p.name, name: n, src });
  };
  for (const p of packs.filter((x) => names.includes(x.name))) {
    if (p.skillsDir) for (const n of entries(p.skillsDir)) if (isDir(path.join(p.skillsDir, n))) take('skills', p, n, path.join(p.skillsDir, n), fs.existsSync(path.join(coreSkills, n)), path.join(coreSkills, n));
    if (p.agentsDir) for (const n of entries(p.agentsDir).filter((x) => x.endsWith('.md'))) take('agents', p, n, path.join(p.agentsDir, n), !!agentsDir && fs.existsSync(path.join(agentsDir, n)), agentsDir && path.join(agentsDir, n));
    for (const g of p.guides) out.guides.push({ pack: p.name, path: g });
  }
  return out;
}

/** La carpeta de agentes del paquete instalado que trae el revisor `name` (`packs/<p>/<agents>/`), o null. La usan quienes
 *  leen el canónico de un revisor por su nombre: el generador de Codex y el banco. */
function agentDirInPacks(packsDir, name) {
  const { packs, errores } = listPacks(packsDir);
  for (const p of packs) if (p.agentsDir && fs.existsSync(path.join(p.agentsDir, `${name}.md`))) return p.agentsDir;
  // no está en ningún paquete legible: si hay uno roto, ése puede ser el suyo — se dice en vez de caer a «no existe»
  if (errores.length) throw new Error(`no encuentro el agente ${name} en los paquetes, y hay paquete(s) roto(s): ${errores.map((e) => `${e.archivo}: ${e.motivo}`).join('; ')}`);
  return null;
}

/** ¿`where` es la pieza `src`? Un enlace simbólico que resuelve ahí, o un enlace duro al mismo archivo (Windows sin el
 *  modo desarrollador). */
function linkedTo(where, src) {
  try {
    if (fs.realpathSync(where) === fs.realpathSync(src)) return true;
    const a = fs.statSync(where); const b = fs.statSync(src);
    return a.isFile() && b.isFile() && a.ino === b.ino && a.dev === b.dev;
  } catch (_) { return false; }
}

/**
 * Los paquetes que activa la organización en este árbol: `{ value, origin, names, error }`. `names` son los instalados
 * activos (`all`: todos; `none`: ninguno; una lista: ésa). Una configuración rota, o un paquete de la lista que no está
 * instalado, da `error` (y `names: null`: no se sabe, que no es «ninguno»).
 */
function orgActive({ tree, env = process.env, home } = {}) {
  const installed = listPacks(packsDirOf(tree)).packs.map((p) => p.name);
  let value; let origin;
  try {
    const C = require('./tycon-config.js');
    const config = C.leer({ env, home });
    value = C.valor(config, 'packs.default');
    origin = (config.origenes && config.origenes['packs.default']) || 'default';
  } catch (e) {
    return { value: null, origin: null, names: null, installed, error: `no pude leer qué paquetes activa la organización (${String((e && e.message) || e).split('\n')[0]})` };
  }
  if (value === 'all') return { value, origin, names: installed, installed, error: null };
  if (value === 'none' || value == null) return { value: value || 'none', origin, names: [], installed, error: null };
  // uno de la lista que está pero con su manifiesto roto no es «no instalado»: se dice roto, con su archivo
  const broken = listPacks(packsDirOf(tree)).errores.filter((e) => value.includes(path.basename(path.dirname(e.archivo))));
  if (broken.length) return { value, origin, names: null, installed, error: `la organización activa ${broken.map((e) => `«${path.basename(path.dirname(e.archivo))}», que está roto (${e.archivo}: ${e.motivo})`).join('; ')}` };
  const missing = value.filter((n) => !installed.includes(n));
  if (missing.length) return { value, origin, names: null, installed, error: `la organización activa ${missing.map((n) => `«${n}»`).join(', ')} y no está instalado en ${packsDirOf(tree)}` };
  return { value, origin, names: installed.filter((n) => value.includes(n)), installed, error: null };
}

/**
 * Las reglas siempre cargadas que traen los paquetes: los `.md` de `packs/<p>/claude-md-blocks/`. Cada una se escribe en el
 * CLAUDE.md (y en el AGENTS.md de Codex) como el bloque `packs/<p>/<nombre>`, sólo mientras la organización activa ese
 * paquete; los sincronizadores quitan el bloque de un paquete que dejó de estar activo o que ya no lo trae. Sólo los `.md`
 * de esa carpeta, sin subcarpetas: un bloque de paquete no tiene variantes por herramienta ni por estilo.
 */
const PACK_BLOCKS_DIR = 'claude-md-blocks';
const PACK_BLOCK_PREFIX = 'packs/';
/** El paquete de un nombre de bloque (`packs/<p>/<n>` → `p`), o null si es un bloque del núcleo. */
const packOfBlock = (name) => { const m = /^packs\/([^/]+)\/[^/]+$/.exec(String(name)); return m ? m[1] : null; };
/** El archivo del que sale un bloque, relativo al árbol (lo nombra la marca de cada bloque escrito). */
const blockSource = (name) => { const p = packOfBlock(name); return p ? `packs/${p}/${PACK_BLOCKS_DIR}/${String(name).split('/')[2]}.md` : `claude-md-blocks/${name}.md`; };

/**
 * Los bloques de los paquetes activos de este árbol: `{ active, error, blocks: [{ name, pack, file }] }`. `active` son los
 * paquetes activos (null si no se pudo saber, con el motivo en `error`): un bloque `packs/<p>/…` escrito cuyo paquete no
 * está en `active` sobra. Sin saber, `blocks` va vacío y nada se quita.
 */
function blocksOf({ tree, env = process.env, home } = {}) {
  const act = orgActive({ tree, env, home });
  if (act.error) return { active: null, error: act.error, blocks: [] };
  const { packs } = listPacks(packsDirOf(tree));
  const blocks = [];
  for (const p of packs.filter((x) => act.names.includes(x.name))) {
    const dir = path.join(p.dir, PACK_BLOCKS_DIR);
    for (const f of entries(dir).filter((n) => n.endsWith('.md'))) {
      const file = path.join(dir, f);
      try { if (!fs.statSync(file).isFile()) continue; } catch (_) { continue; }
      blocks.push({ name: `${PACK_BLOCK_PREFIX}${p.name}/${f.slice(0, -3)}`, pack: p.name, file });
    }
  }
  return { active: act.names, error: null, blocks };
}

/** Cómo se dice el valor en una línea. */
const valueText = (v) => (Array.isArray(v) ? `[${v.join(', ')}]` : String(v));
/** Dónde se activa un paquete, en una línea (la misma frase del freno del pipeline). */
const WHERE_TO_ACTIVATE = 'activalo en Configuración del sitio, sección Paquetes, o en el perfil del equipo (packs.default; en esta máquina, TYCON_PACKS_DEFAULT)';
/**
 * La línea con que el aplicador dice que sacó piezas de paquetes que la organización no activa. La arma `retiredLine` y la
 * reconoce `RETIRED_RX` (harness.js y release.js la buscan en la salida del aplicador para decírsela a la persona): las
 * dos salen de acá, para que un cambio de redacción no la haga desaparecer en silencio.
 */
const RETIRED_PHRASE = 'pieza(s) de paquete(s) que la organización no activa';
const RETIRED_RX = /pieza\(s\) de paquete\(s\) que la organización no activa/;
function retiredLine({ check = false, count, packs, pieces, value, origin }) {
  return `${check ? 'sacaría' : 'se sacaron'} ${count} ${RETIRED_PHRASE} (${packs.join(', ')}: ${pieces.join(', ')}) — packs.default es ${valueText(value)} (${origin}); para usarlas, ${WHERE_TO_ACTIVATE}`;
}

/** El lector de la configuración del arnés de este árbol (lo pide la sección «Paquetes» de org-config.js), o null. */
function configReader() { try { return require('./tycon-config.js'); } catch (_) { return null; } }

module.exports = { packsDirOf, listPacks, piecesOf, agentDirInPacks, linkedTo, orgActive, blocksOf, packOfBlock, blockSource, PACK_BLOCKS_DIR, PACK_BLOCK_PREFIX, valueText, folderProblem, configReader, retiredLine, WHERE_TO_ACTIVATE, RETIRED_PHRASE, RETIRED_RX };

// `node pack-pieces.js blocks --json [--tree <árbol>]`: los bloques de los paquetes activos, para los sincronizadores que no
// son de Node (sync-claude-md-blocks.sh y .ps1, el plan de install-tycon-hooks.ps1). Sale 0 siempre que contestó; 2 por uso.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf('--tree');
  const tree = ti !== -1 && argv[ti + 1] ? path.resolve(argv[ti + 1]) : path.resolve(__dirname, '..', '..');
  if (argv[0] !== 'blocks' || !argv.includes('--json')) {
    process.stderr.write('uso: node pack-pieces.js blocks --json [--tree <árbol>]\n');
    process.exit(2);
  }
  let r;
  try { r = blocksOf({ tree }); } catch (e) { r = { active: null, error: `no pude leer los bloques de los paquetes (${String((e && e.message) || e).split('\n')[0]})`, blocks: [] }; }
  process.stdout.write(`${JSON.stringify(r)}\n`);
}
