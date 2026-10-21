#!/usr/bin/env node
/**
 * build/deploy-shared-skills.js — expone las skills del arnés a Codex vía symlinks en
 * ~/.codex/skills. Lo invoca install-tycon-hooks.sh (TYCON_CODEX=1).
 *
 * Fuente: el clon de agent-skills (~/.claude/agent-skills/skills — override TYCON_SKILLS_DIR).
 * Un symlink por skill → cero copias, cero drift: la skill que Claude lee es EXACTAMENTE la
 * que Codex lee (formato SKILL.md estándar en ambas, plan §7).
 *
 * 🔴 La ruta ~/.agents/skills la leen AMBAS herramientas, y no se usa: Claude YA recibe estas skills vía el mecanismo
 * de agent-skills, y ponerlas también ahí se las DUPLICARÍA en el listado. ~/.codex/skills es la ruta que
 * SOLO codex lee: mismo resultado, cero duplicación del lado Claude.
 *
 * Propiedad por TARGET del symlink (apunta adentro del clon de agent-skills) — igual que el
 * deployer de hooks: lo que el dev haya puesto a mano en ~/.codex/skills (dirs reales o
 * symlinks a otro lado) queda INTACTO. Symlinks propios cuyo origen desapareció se limpian.
 * Idempotente · --dry-run · --selftest (offline, dirs temporales).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * `packs`: `{ root, extra: [{ name, src }], retire: [carpetas] }` — las skills de los paquetes que activa la
 * organización se enlazan igual que las del núcleo; un enlace nuestro a un paquete que dejó de estar activo se saca.
 * `root` es la carpeta de paquetes del clon: un enlace que apunta ahí también es nuestro.
 */
function deploySkills(srcDir, dstDir, packs = null) {
  // `clashes`: skills de un paquete que no se enlazan porque el núcleo trae una con el mismo nombre
  const actions = { linked: [], kept: 0, cleaned: [], skipped: [], clashes: [] };
  if (!fs.existsSync(srcDir)) return { actions, error: `no existe ${srcDir}` };
  fs.mkdirSync(dstDir, { recursive: true });
  const under = (t, d) => t === d || t.startsWith(d + path.sep);
  const ours = (p) => {
    try { const t = fs.readlinkSync(p); return under(t, srcDir) || (!!packs && !!packs.root && under(t, packs.root)) || (!!packs && !!packs.intRoot && under(t, packs.intRoot)); }
    catch (_) { return false; } // no es symlink → del dev, intocable
  };
  // lo que se enlaza: las del núcleo y, sin pisarlas, las de los paquetes activos
  const sources = new Map();
  for (const name of fs.readdirSync(srcDir)) sources.set(name, path.join(srcDir, name));
  for (const x of (packs && packs.extra) || []) {
    if (sources.has(x.name)) { actions.clashes.push(`${x.name} (del paquete ${x.pack})`); continue; }
    sources.set(x.name, x.src);
  }
  // limpiar symlinks propios muertos, renombrados o de un paquete que la organización ya no activa
  for (const name of fs.readdirSync(dstDir)) {
    const p = path.join(dstDir, name);
    let st; try { st = fs.lstatSync(p); } catch (_) { continue; }
    if (!st.isSymbolicLink() || !ours(p)) continue;
    const target = sources.get(name);
    const retired = !!packs && (packs.retire || []).some((d) => under(fs.readlinkSync(p), d));
    if (!target || !fs.existsSync(target) || retired) { fs.unlinkSync(p); actions.cleaned.push(name); }
  }
  // crear/actualizar un symlink por skill del clon
  for (const [name, src] of sources) {
    // stat (no lstat): seguir symlinks válidos del clon; los ROTOS (target muerto) se saltean
    // — el clon real puede tenerlos (p.ej. accessibility) y statSync tira ENOENT.
    let stSrc = null; try { stSrc = fs.statSync(src); } catch (_) { continue; }
    if (!stSrc.isDirectory()) continue;
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue; // solo skills reales
    const dst = path.join(dstDir, name);
    let st = null; try { st = fs.lstatSync(dst); } catch (_) {}
    if (st && !st.isSymbolicLink()) { actions.skipped.push(name); continue; } // dir real del dev
    if (st && st.isSymbolicLink()) {
      if (ours(dst) && fs.readlinkSync(dst) === src) { actions.kept++; continue; }
      if (!ours(dst)) { actions.skipped.push(name); continue; } // symlink del dev a otro lado
      fs.unlinkSync(dst);
    }
    // win32: 'junction' — funciona sin admin/developer-mode y readlink devuelve el target
    fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : null);
    actions.linked.push(name);
  }
  return { actions };
}

/**
 * Clasifica el DESTINO de un skill con la MISMA política de propiedad que deploySkills — el
 * audit de paridad la importa en vez de re-derivarla (una copia a mano termina divergiendo).
 *   'ausente'    → no hay nada: el deploy lo crearía (rojo remediable).
 *   'ok'         → symlink nuestro apuntando al skill.
 *   'roto'       → symlink NUESTRO con target muerto o renombrado: el deploy lo limpia/re-crea.
 *   'dev'        → dir real o symlink ajeno: del dev, intocable — jamás un rojo.
 */
function linkState(dstPath, srcDir, name) {
  let st; try { st = fs.lstatSync(dstPath); } catch (_) { return 'ausente'; }
  if (!st.isSymbolicLink()) return 'dev';
  let target; try { target = fs.readlinkSync(dstPath); } catch (_) { return 'dev'; }
  const nuestro = target.startsWith(srcDir + path.sep) || target === srcDir;
  if (!nuestro) return 'dev';
  if (!fs.existsSync(dstPath) || target !== path.join(srcDir, name)) return 'roto';
  return 'ok';
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-skilltest-'));
  const src = path.join(tmp, 'agent-skills', 'skills');
  const dst = path.join(tmp, 'codex-skills');
  const mk = (dir, skill, withMd = true) => {
    fs.mkdirSync(path.join(dir, skill), { recursive: true });
    if (withMd) fs.writeFileSync(path.join(dir, skill, 'SKILL.md'), '# x');
  };
  mk(src, 'tycon-pipeline'); mk(src, 'acme-skill'); mk(src, 'carpeta-sin-skill', false);
  fs.symlinkSync(path.join(tmp, 'target-muerto'), path.join(src, 'symlink-roto')); // el caso del clon real
  fs.mkdirSync(dst, { recursive: true });
  mk(dst, 'skill-real-del-dev');                                   // dir real → intocable
  fs.symlinkSync('/tmp/otro-lado', path.join(dst, 'ajeno'));       // symlink del dev → intocable
  fs.symlinkSync(path.join(src, 'skill-que-ya-no-existe'), path.join(dst, 'muerta')); // propio muerto
  const r1 = deploySkills(src, dst).actions;
  const r2 = deploySkills(src, dst).actions;
  const checks = [
    ['linkea solo dirs con SKILL.md', r1.linked.sort().join(',') === 'acme-skill,tycon-pipeline'],
    ['la carpeta sin SKILL.md no se linkea', !fs.existsSync(path.join(dst, 'carpeta-sin-skill'))],
    ['el dir real del dev queda intacto', fs.existsSync(path.join(dst, 'skill-real-del-dev'))],
    ['el symlink ajeno queda intacto', fs.readlinkSync(path.join(dst, 'ajeno')) === '/tmp/otro-lado'],
    ['el symlink propio muerto se limpia', r1.cleaned.includes('muerta') && !fs.existsSync(path.join(dst, 'muerta'))],
    ['idempotente: 2ª corrida no re-linkea', r2.linked.length === 0 && r2.kept === 2],
    ['symlink ROTO en el clon se saltea sin crash', !fs.existsSync(path.join(dst, 'symlink-roto'))],
  ];
  fs.rmSync(tmp, { recursive: true, force: true });
  let bad = 0;
  for (const [name, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-skills: ${name}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ selftest-skills: ${checks.length}/${checks.length} verdes`);
  return bad ? 1 : 0;
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();
  // Resolución TOLERANTE de TYCON_SKILLS_DIR (raíz del clon O carpeta de skills — las dos
  // semánticas conviven documentadas; ver scripts/lib/skills-dir.js). La variante «instalada»: los enlaces de
  // ~/.codex/skills quedan ESCRITOS en la máquina y no tienen que moverse mientras haya dos clones.
  const src = require(path.join(__dirname, '..', 'scripts', 'lib', 'skills-dir.js')).resolveInstalledSkillsDirs().skills;
  const dst = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills');
  if (process.argv.includes('--dry-run')) { console.log(`deploy-shared-skills: ${src} → ${dst} (dry-run)`); return 0; }
  const { actions, error } = deploySkills(src, dst, packSkills(path.dirname(src)));
  if (error) {
    // A stderr y exit 1: "no encontré el clon de agent-skills" es un despliegue FALLIDO, no un
    // "nada que hacer" — con exit 0 el instalador no puede enterarse, y una máquina Codex sin
    // skills queda muda para siempre.
    console.error(`deploy-shared-skills: ${error}`);
    return 1;
  }
  console.log(`deploy-shared-skills: +${actions.linked.length} nuevas · ${actions.kept} al día · ${actions.cleaned.length} limpiadas · ${actions.skipped.length} del dev respetadas → ${dst}`);
  if (actions.clashes.length) console.log(`deploy-shared-skills: no enlazo ${actions.clashes.join(', ')}: el núcleo trae una skill con ese nombre`);
  return 0;
}

/** Las skills de los paquetes del clon `tree` para `deploySkills` (null si el clon no trae paquetes o no se sabe qué activa
 *  la organización: entonces no se agrega ni se saca nada de ningún paquete). */
function packSkills(tree) {
  return withIntegrationSkills(tree, packOnlySkills(tree));
}

/**
 * Suma las skills de las integraciones (`skills` de su manifiesto): las de la integración de horas elegida se enlazan
 * como las de un paquete activo; las de las demás se retiran. `intRoot`: un enlace que apunta ahí también es nuestro.
 */
function withIntegrationSkills(tree, packs) {
  let INT;
  const lib = path.join(tree, 'scripts', 'lib', 'integrations.js');
  try { INT = require(lib); } catch (e) {
    if (fs.existsSync(lib)) console.error(`deploy-shared-skills: no pude cargar integrations.js (${e.code || e.message}): las skills de las integraciones quedan como están`);
    return packs;
  }
  const dir = path.join(tree, 'integrations');
  const listing = INT.listManifests({ dir });
  // un manifiesto roto no enlaza ni retira sus skills, y se dice (si es el elegido, su /skill queda como estaba)
  for (const b of listing.problems) console.error(`deploy-shared-skills: la integración «${b.name}» tiene el manifiesto roto (${b.reasons.join('; ')}): sus skills quedan como están`);
  const manifests = listing.manifests.filter((m) => m.skills.length);
  if (!manifests.length) return packs;
  let chosen;
  try { const TC = require(path.join(tree, 'scripts', 'lib', 'tycon-config.js')); chosen = TC.timeTracking(TC.leer({ arnes: tree })).value; } catch (e) {
    console.error(`deploy-shared-skills: no pude leer qué integración de horas está elegida (${String((e && e.message) || e).split('\n')[0]}): no agrego ni saco sus skills`);
    return packs;
  }
  const out = Object.assign({ root: null, extra: [], retire: [] }, packs || {}, { intRoot: dir });
  out.extra = out.extra.slice(); out.retire = out.retire.slice();
  for (const m of manifests) for (const rel of m.skills) {
    const src = path.join(m.dir, rel);
    if (m.name === chosen) out.extra.push({ name: path.basename(rel), src, pack: `integración ${m.name}` });
    else out.retire.push(src);
  }
  return out;
}

function packOnlySkills(tree) {
  const lib = path.join(tree, 'scripts', 'lib', 'pack-pieces.js');
  if (!fs.existsSync(lib)) return null;
  const PP = require(lib);
  const root = PP.packsDirOf(tree);
  const { packs, errores } = PP.listPacks(root);
  // un paquete roto se dice: sus skills no se enlazan, y eso no es «sin paquetes»
  for (const e of errores) console.error(`deploy-shared-skills: el paquete ${e.archivo} está roto (${e.motivo}): sus skills no se enlazan`);
  if (!packs.length) return null;
  const org = PP.orgActive({ tree });
  if (org.error) { console.error(`deploy-shared-skills: ${org.error} — no agrego ni saco skills de ningún paquete`); return null; }
  const pz = PP.piecesOf({ packsDir: root, names: org.names });
  // un nombre repetido (entre dos paquetes o con el núcleo) no se enlaza dos veces: se dice cuál quedó afuera
  for (const e of pz.errores) if (!errores.some((x) => x.archivo === e.archivo && x.motivo === e.motivo)) console.error(`deploy-shared-skills: ${e.archivo}: ${e.motivo}`);
  const { skills } = pz;
  const retire = packs.filter((p) => !org.names.includes(p.name) && p.skillsDir).map((p) => p.skillsDir);
  return { root, extra: skills, retire };
}

module.exports = { deploySkills, linkState, packSkills, withIntegrationSkills };
if (require.main === module) process.exit(main());
