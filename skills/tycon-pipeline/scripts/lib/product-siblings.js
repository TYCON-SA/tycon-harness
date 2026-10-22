/**
 * product-siblings.js — los otros repos del MISMO producto que un repo, en la máquina.
 *
 * Estar en la misma carpeta no hace a dos repos del mismo producto: la carpeta puede ser la raíz de todos los repos,
 * la de los worktrees o la temporal, con repos de cualquier cosa. Cuenta como del mismo producto un repo:
 *   - declarado como compañero en `.tycon/advisors.yaml → evidence.companion_repos` del repo, o
 *   - de la misma carpeta y con su `origin` en el mismo proyecto de Azure DevOps (organización y proyecto).
 * Un repo sin remoto, o con un remoto que no dice el proyecto (GitHub: un dueño tiene muchos productos), no es hermano
 * de nadie por vecindad; si lo es, se declara.
 *
 * Lo usan la skill de historias (dónde viven las historias de un producto) y el lint de frontmatter (dónde está el
 * código que nombra una story). Sin procesos: el remoto se lee del archivo de configuración de git.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseEvidenceConfig } = require('./evidence-config.js');

/** El directorio de git que guarda la configuración (sigue `.git` como archivo, el de un worktree). */
function gitCommonDir(repo) {
  const dotGit = path.join(repo, '.git');
  let st;
  try { st = fs.statSync(dotGit); } catch { return null; }
  if (st.isDirectory()) return dotGit;
  try {
    const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
    if (!m) return null;
    const gitdir = path.resolve(repo, m[1]);
    let common = gitdir;
    try { common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()); } catch { /* sin commondir: es el mismo */ }
    return common;
  } catch { return null; }
}

/** La URL de `origin`, o null. */
function originUrl(repo) {
  const dir = gitCommonDir(repo);
  if (!dir) return null;
  let txt;
  try { txt = fs.readFileSync(path.join(dir, 'config'), 'utf8'); } catch { return null; }
  let inOrigin = false;
  for (const line of txt.split(/\r?\n/)) {
    const sec = line.match(/^\s*\[(.+)\]\s*$/);
    if (sec) { inOrigin = /^remote\s+"origin"$/.test(sec[1].trim()); continue; }
    const kv = inOrigin && line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (kv) return kv[1];
  }
  return null;
}

/** `azure:<organización>/<proyecto>` de una URL de Azure DevOps (https o ssh, dominio nuevo o viejo), o null. */
function productKey(url) {
  if (!url) return null;
  const u = String(url);
  const m = u.match(/(?:dev\.azure\.com|vs-ssh\.visualstudio\.com)[/:](?:v3\/)?([^/]+)\/([^/]+)\/(?:_git\/)?[^/]+$/i)
    || u.match(/([^/.@:]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/[^/]+$/i);
  if (!m) return null;
  let project = m[2];
  try { project = decodeURIComponent(project); } catch { /* queda como está */ }
  return `azure:${m[1]}/${project}`.toLowerCase();
}

/** Los repos del mismo producto que `repo` (rutas absolutas, sin el propio), en orden. */
function productSiblings(repo) {
  const out = new Set();
  let companions = [];
  try { companions = parseEvidenceConfig(repo).roots || []; } catch { companions = []; }
  for (const c of companions) if (path.resolve(c) !== path.resolve(repo) && fs.existsSync(c)) out.add(path.resolve(c));
  const own = originUrl(repo);
  const key = productKey(own);
  if (key) {
    const same = (u) => String(u).replace(/^https?:\/\/[^@/]+@/i, 'https://').replace(/\.git$/, '').toLowerCase();
    const parent = path.dirname(repo);
    let entries = [];
    try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { entries = []; }
    // el mismo remoto es el mismo repo (un worktree, otra copia): no es otro repo del producto, y cuenta una sola vez
    const seen = new Set([same(own)]);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const d = path.join(parent, e.name);
      if (!e.isDirectory() || d === repo || e.name.startsWith('.')) continue;
      const url = originUrl(d);
      if (productKey(url) !== key || seen.has(same(url))) continue;
      seen.add(same(url));
      out.add(d);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

module.exports = { productSiblings, productKey, originUrl };
