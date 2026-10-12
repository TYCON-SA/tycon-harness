#!/usr/bin/env node
/**
 * build/deploy-shared-skills.js — expone las skills del arnés a Codex vía symlinks en
 * ~/.codex/skills (Etapa F1, 2026-08-22). Lo invoca install-tycon-hooks.sh (TYCON_CODEX=1).
 *
 * Fuente: el clon de agent-skills (~/.claude/agent-skills/skills — override TYCON_SKILLS_DIR).
 * Un symlink por skill → cero copias, cero drift: la skill que Claude lee es EXACTAMENTE la
 * que Codex lee (formato SKILL.md estándar en ambas, plan §7).
 *
 * 🔴 Desviación deliberada de la sonda 1 (que sugería ~/.agents/skills, la ruta que AMBAS
 * herramientas leen): Claude YA recibe estas skills vía el mecanismo de agent-skills — ponerlas
 * también en ~/.agents/skills se las DUPLICARÍA en el listado. ~/.codex/skills es la ruta que
 * SOLO codex lee (verificado sonda 1): mismo resultado, cero duplicación del lado Claude.
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

function deploySkills(srcDir, dstDir) {
  const actions = { linked: [], kept: 0, cleaned: [], skipped: [] };
  if (!fs.existsSync(srcDir)) return { actions, error: `no existe ${srcDir}` };
  fs.mkdirSync(dstDir, { recursive: true });
  const ours = (p) => {
    try { return fs.readlinkSync(p).startsWith(srcDir + path.sep) || fs.readlinkSync(p) === srcDir; }
    catch (_) { return false; } // no es symlink → del dev, intocable
  };
  // limpiar symlinks propios muertos o renombrados
  for (const name of fs.readdirSync(dstDir)) {
    const p = path.join(dstDir, name);
    let st; try { st = fs.lstatSync(p); } catch (_) { continue; }
    if (!st.isSymbolicLink() || !ours(p)) continue;
    const target = path.join(srcDir, name);
    if (!fs.existsSync(target)) { fs.unlinkSync(p); actions.cleaned.push(name); }
  }
  // crear/actualizar un symlink por skill del clon
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    // stat (no lstat): seguir symlinks válidos del clon; los ROTOS (target muerto) se saltean
    // — el clon real los tiene (p.ej. accessibility, 2026-08-22) y statSync tira ENOENT.
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
 * audit de paridad la importa en vez de re-derivarla (2ª ronda adversarial: la copia a mano ya
 * había divergido una vez, y este era el único deployer sin exportar su política).
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
  mk(src, 'tycon-pipeline'); mk(src, 'clocki'); mk(src, 'carpeta-sin-skill', false);
  fs.symlinkSync(path.join(tmp, 'target-muerto'), path.join(src, 'symlink-roto')); // el caso del clon real
  fs.mkdirSync(dst, { recursive: true });
  mk(dst, 'skill-real-del-dev');                                   // dir real → intocable
  fs.symlinkSync('/tmp/otro-lado', path.join(dst, 'ajeno'));       // symlink del dev → intocable
  fs.symlinkSync(path.join(src, 'skill-que-ya-no-existe'), path.join(dst, 'muerta')); // propio muerto
  const r1 = deploySkills(src, dst).actions;
  const r2 = deploySkills(src, dst).actions;
  const checks = [
    ['linkea solo dirs con SKILL.md', r1.linked.sort().join(',') === 'clocki,tycon-pipeline'],
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
  // ~/.codex/skills quedan ESCRITOS en la máquina y no tienen que moverse mientras haya dos clones (story 8.18, I12).
  const src = require(path.join(__dirname, '..', 'scripts', 'lib', 'skills-dir.js')).resolveInstalledSkillsDirs().skills;
  const dst = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills');
  if (process.argv.includes('--dry-run')) { console.log(`deploy-shared-skills: ${src} → ${dst} (dry-run)`); return 0; }
  const { actions, error } = deploySkills(src, dst);
  if (error) {
    // A stderr y exit 1: "no encontré el clon de agent-skills" es un despliegue FALLIDO, no un
    // "nada que hacer" — con exit 0 el instalador no puede enterarse, y una máquina Codex sin
    // skills queda muda para siempre (hallazgo de la revisión 2026-08-23).
    console.error(`deploy-shared-skills: ${error}`);
    return 1;
  }
  console.log(`deploy-shared-skills: +${actions.linked.length} nuevas · ${actions.kept} al día · ${actions.cleaned.length} limpiadas · ${actions.skipped.length} del dev respetadas → ${dst}`);
  return 0;
}

module.exports = { deploySkills, linkState };
if (require.main === module) process.exit(main());
