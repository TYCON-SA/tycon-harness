#!/usr/bin/env node
'use strict';
// third-party-coverage.js — nada ajeno sin declarar en agent-skills, nada declarado de más (story 8.5 · 2026-09-29)
//
// POR QUÉ EXISTE: agent-skills distribuía ~2.000 archivos ajenos —cuatro skills con licencia propietaria entre ellos—
// y nada decía de quién era cada cosa. El manifiesto (third-party-skills.json, al lado) lo dice; este control verifica
// que el manifiesto y el repo no se separen: una skill de internet copiada al árbol sin declarar se ve el día que se
// copia (el pre-commit de agent-skills lo corre), no cuando alguien la publica.
//
// QUÉ MIRA, sobre lo VERSIONADO (el índice: `git ls-files -s`, nunca el disco — lo no versionado de cada máquina no es
// asunto del repo). Sin red: no abre ninguna conexión.
//   · Universos (AC 6): cada ruta cae en exactamente uno de own / derived / third_party. En ninguno o en dos → hallazgo.
//   · Declaraciones (AC 7): con el retiro pendiente, cada entrada tiene que estar versionada (si no, está muerta); con el
//     retiro hecho, ninguna puede estarlo y cada una tiene que estar en el .gitignore del repo.
//   · Enlaces simbólicos (AC 8): uno versionado es hallazgo a cualquier profundidad, salvo que una entrada lo declare
//     en `links` con el retiro pendiente (se informa, sale con el retiro).
//   · Contenido (AC 5, sólo con el retiro pendiente y sin --skip-content): cada entrada `download` da su `tree` con
//     `HEAD:<target>`; si no, nombra la entrada y los archivos distintos, faltantes o de más.
//
// SALIDA: exit 0 = coincide · 1 = hay hallazgos · 2 = no pude mirar (manifiesto ilegible o mal formado, repo que no
// es git). El mismo contrato que el detector: nunca «limpio» cuando no pudo mirar.
//
// A mano:
//   node scripts/publishing/third-party-coverage.js [--repo <agent-skills>] [--manifest <json>] [--skip-content] [--json]
//   Sin --repo: el agent-skills de scripts/lib/skills-dir.js (TYCON_SKILLS_DIR o ~/.claude/agent-skills).
//   --skip-content: sólo universos, declaraciones y enlaces (lo que corre el pre-commit, en milisegundos).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_MANIFEST = path.join(__dirname, 'third-party-skills.json');
const INSTALL_KINDS = ['download', 'official-plugin', 'retire'];
const DERIVED_REPOS = ['agent-skills', 'tycon-claude-guides'];
// Vocabulario CERRADO de licencias (AC 3): un identificador SPDX conocido, la propietaria o «no declarada». Un valor
// fuera de acá es un error del manifiesto, no una licencia nueva: se agrega a esta lista con su motivo.
const LICENSES = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'CC0-1.0', 'CC-BY-4.0',
  'CC-BY-SA-4.0', 'Unlicense', '0BSD', 'Zlib', 'BSL-1.0', 'GPL-2.0-only', 'GPL-3.0-only', 'LGPL-2.1-only', 'LGPL-3.0-only',
  'AGPL-3.0-only', 'LicenseRef-Proprietary', 'NOASSERTION']);
const SHA = /^[0-9a-f]{40}$/;
// Un origen es una URL con esquema (https://, http://, file://, ssh://) o `usuario@host:ruta`. Nunca algo que empiece con
// `-`: va como argumento a `git fetch`, y ahí sería una opción (`--upload-pack=…` ejecuta lo que diga).
const ORIGIN = /^(?:(?:https?|file|ssh):\/\/[^\s]+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+)$/;
const validOrigin = (o) => typeof o === 'string' && !o.startsWith('-') && ORIGIN.test(o);
const MODES = ['100644', '100755'];

class ManifestError extends Error {}

// ── globs: `**` cruza carpetas, `*` y `?` no; un glob cubre una ruta si la nombra a ella o a una carpeta que la contiene ──
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
function ancestors(p) {
  const parts = p.split('/');
  const out = [];
  for (let i = parts.length; i > 0; i--) out.push(parts.slice(0, i).join('/'));
  return out;
}
const isUnder = (p, target) => p === target || p.startsWith(`${target}/`);

// ── el manifiesto ───────────────────────────────────────────────────────────────────────────────────────────────
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

function validateTarget(target, where, errors) {
  if (!nonEmpty(target)) { errors.push(`${where}: el campo «target» tiene que ser UNA ruta (texto), no ${JSON.stringify(target)}`); return false; }
  if (/[*?{}[\],]/.test(target) || target.startsWith('/') || target.endsWith('/') || target.split('/').includes('..')) {
    errors.push(`${target}: el campo «target» nombra una sola carpeta o archivo, sin globs, llaves ni comas (una entrada por destino)`);
    return false;
  }
  return true;
}

function validateLicense(label, lic, errors) {
  if (!nonEmpty(lic.license)) errors.push(`${label}: el campo «license» está vacío (SPDX, LicenseRef-Proprietary o NOASSERTION)`);
  else if (!LICENSES.has(lic.license)) errors.push(`${label}: el campo «license» dice «${lic.license}», que no está en el vocabulario (${[...LICENSES].join(', ')})`);
  if (!nonEmpty(lic.license_source)) errors.push(`${label}: el campo «license_source» está vacío: dónde se leyó la licencia, o dónde se buscó sin encontrarla`);
}

/** Errores de forma del manifiesto (vacío = bien formado). Cada error nombra la entrada y el campo. */
function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['el manifiesto no es un objeto JSON'];
  if (!['pending', 'done'].includes(m.retirement)) errors.push(`retirement: tiene que ser «pending» o «done», no ${JSON.stringify(m.retirement)}`);
  for (const k of ['own', 'derived', 'third_party']) if (!Array.isArray(m[k])) errors.push(`${k}: falta la lista`);
  const origins = m.origins && typeof m.origins === 'object' ? m.origins : {};
  for (const [key, o] of Object.entries(origins)) {
    if (!o || !validOrigin(o.origin)) errors.push(`origins.${key}: el campo «origin» tiene que ser una URL con esquema (https://, file://, ssh://) o usuario@host:ruta, nunca una opción; no ${JSON.stringify(o && o.origin)}`);
    if (!o || !SHA.test(o.commit || '')) errors.push(`origins.${key}: el campo «commit» tiene que ser un sha de 40 hexadecimales (nunca una rama ni un tag), no ${JSON.stringify(o && o.commit)}`);
  }
  (Array.isArray(m.own) ? m.own : []).forEach((o, i) => {
    if (!o || !nonEmpty(o.glob)) errors.push(`own[${i}]: falta «glob»`);
    else if (!nonEmpty(o.why)) errors.push(`own[${i}] (${o.glob}): falta «why»`);
  });
  const seen = new Map();
  const remember = (target, where) => {
    if (seen.has(target)) errors.push(`${target}: declarado dos veces (${seen.get(target)} y ${where}): una entrada por destino`);
    else seen.set(target, where);
  };
  (Array.isArray(m.derived) ? m.derived : []).forEach((d, i) => {
    if (!d || !validateTarget(d.target, `derived[${i}]`, errors)) return;
    remember(`${d.repo}:${d.target}`, 'derived');
    if (!DERIVED_REPOS.includes(d.repo)) errors.push(`${d.target}: el campo «repo» tiene que ser ${DERIVED_REPOS.join(' o ')}`);
    validateLicense(d.target, d, errors);
    if (!nonEmpty(d.copyright)) errors.push(`${d.target}: una derivada lleva «copyright» (a quién se le atribuye)`);
    if (!nonEmpty(d.why)) errors.push(`${d.target}: falta «why»`);
  });
  (Array.isArray(m.third_party) ? m.third_party : []).forEach((e, i) => {
    if (!e || !validateTarget(e.target, `third_party[${i}]`, errors)) return;
    remember(`agent-skills:${e.target}`, 'third_party');
    const t = e.target;
    const eff = resolveEntry(e, origins);
    if (e.from !== undefined && !origins[e.from]) errors.push(`${t}: el campo «from» nombra «${e.from}», que no está en origins`);
    if (!INSTALL_KINDS.includes(e.install)) errors.push(`${t}: el campo «install» tiene que ser ${INSTALL_KINDS.join(' | ')}, no ${JSON.stringify(e.install)}`);
    validateLicense(t, eff, errors);
    if (eff.license === 'LicenseRef-Proprietary' && e.install === 'download') {
      errors.push(`${t}: el campo «install» no puede ser download con licencia propietaria: el paso no la baja nunca (official-plugin o retire)`);
    }
    if (!Array.isArray(e.used_by)) errors.push(`${t}: el campo «used_by» tiene que ser una lista (puede ser vacía)`);
    // `publish: true` (2026-10-05): la copia pública la baja aunque nada de lo que sale la use. Sólo en una que se baja
    // y con licencia libre: en otra la transformación la poda igual, y la marca diría algo que no pasa.
    if (e.publish !== undefined && typeof e.publish !== 'boolean') errors.push(`${t}: el campo «publish» tiene que ser true o false`);
    else if (e.publish === true && (e.install !== 'download' || !['MIT', 'Apache-2.0'].includes(eff.license))) {
      errors.push(`${t}: el campo «publish» sólo vale en una entrada que se baja (install: download) con licencia MIT o Apache-2.0, no ${e.install} con ${eff.license}`);
    }
    if (!nonEmpty(e.why)) errors.push(`${t}: falta «why»`);
    if (e.links !== undefined && (!Array.isArray(e.links) || !e.links.every(nonEmpty))) errors.push(`${t}: el campo «links» tiene que ser una lista de rutas`);
    if (e.install === 'official-plugin') {
      if (!nonEmpty(e.plugin)) errors.push(`${t}: una entrada official-plugin nombra su «plugin»`);
      if (e.path !== undefined || e.tree !== undefined) errors.push(`${t}: una entrada official-plugin no lleva «path» ni «tree»: el paso no la baja nunca`);
    }
    if (e.install === 'download') {
      if (!validOrigin(eff.origin)) errors.push(`${t}: el campo «origin» (en la entrada o en su bloque de origins) tiene que ser una URL con esquema o usuario@host:ruta, nunca una opción; no ${JSON.stringify(eff.origin)}`);
      if (!SHA.test(eff.commit || '')) errors.push(`${t}: el campo «commit» tiene que ser un sha de 40 hexadecimales (nunca una rama ni un tag), no ${JSON.stringify(eff.commit)}`);
      if (typeof e.path !== 'string') errors.push(`${t}: falta «path» (la carpeta dentro del origen; "" es la raíz)`);
    }
    if ((e.install === 'download' || e.tree !== undefined) && !SHA.test(e.tree || '')) errors.push(`${t}: el campo «tree» tiene que ser el hash de árbol de git (40 hexadecimales)`);
    if (e.install === 'download' || e.omit !== undefined) {
      if (!Array.isArray(e.omit)) errors.push(`${t}: el campo «omit» tiene que ser una lista (vacía si no hay)`);
      else e.omit.forEach((o, j) => {
        if (!o || !nonEmpty(o.file) || !nonEmpty(o.reason)) errors.push(`${t}: omit[${j}] necesita «file» y «reason»`);
      });
    }
    if (e.mode_fixes !== undefined) {
      if (!Array.isArray(e.mode_fixes)) errors.push(`${t}: el campo «mode_fixes» tiene que ser una lista`);
      else e.mode_fixes.forEach((o, j) => {
        if (!o || !nonEmpty(o.file) || !MODES.includes(o.mode) || !nonEmpty(o.reason)) errors.push(`${t}: mode_fixes[${j}] necesita «file», «mode» (${MODES.join(' o ')}) y «reason»`);
      });
    }
  });
  // un enlace es de UNA entrada: declarado en dos, el control no sabría con cuál sale
  const linkOwner = new Map();
  for (const e of Array.isArray(m.third_party) ? m.third_party : []) {
    for (const l of (e && Array.isArray(e.links) ? e.links : [])) {
      if (linkOwner.has(l)) errors.push(`${l}: el enlace está declarado dos veces (en ${linkOwner.get(l)} y en ${e.target})`);
      else linkOwner.set(l, e.target);
    }
  }
  // una entrada dentro de otra: el destino de una pisaría el de la otra
  const targets = (Array.isArray(m.third_party) ? m.third_party : []).map((e) => e && e.target).filter(nonEmpty);
  for (const a of targets) for (const b of targets) if (a !== b && isUnder(a, b)) errors.push(`${a}: está dentro de otra entrada (${b})`);
  return errors;
}

/** La entrada con lo que hereda de su bloque de origins (origen, commit y licencia; la entrada pisa). */
function resolveEntry(e, origins = {}) {
  const base = (e.from && origins[e.from]) || {};
  const pick = (k) => (Object.prototype.hasOwnProperty.call(e, k) ? e[k] : base[k]);
  return { ...e, origin: pick('origin'), commit: pick('commit'), license: pick('license'), license_source: pick('license_source'), copyright: pick('copyright') };
}

/** Lee y valida; tira ManifestError con TODOS los errores (el que arregla uno no tiene que volver a correr para ver el siguiente). */
function loadManifest(file = DEFAULT_MANIFEST) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ManifestError(`no pude leer el manifiesto ${file} (${e.code || e.message})`);
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch (e) {
    throw new ManifestError(`el manifiesto ${file} no es JSON válido (${e.message})`);
  }
  const errors = validateManifest(m);
  if (errors.length) throw new ManifestError(`el manifiesto ${file} está mal formado:\n  · ${errors.join('\n  · ')}`);
  const origins = m.origins || {};
  return {
    file,
    retirement: m.retirement,
    own: m.own.map((o) => ({ ...o, re: globToRegex(o.glob) })),
    derived: m.derived,
    thirdParty: m.third_party.map((e) => resolveEntry(e, origins)),
  };
}

// ── git ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Sin limpiar las variables GIT_*: desde el pre-commit, GIT_INDEX_FILE es el índice del commit que se está armando
// (con `git commit -a` es un índice temporal), y es justo el que hay que mirar.
function git(repo, args, input) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new ManifestError(`no pude correr git (${r.error.code || r.error.message})`);
  return r;
}

/** Lo versionado: [{mode, path}] del índice (una sola vez por ruta, aunque haya etapas de un merge a medias). */
function listVersioned(repo) {
  const r = git(repo, ['ls-files', '-s', '-z']);
  if (r.status !== 0) throw new ManifestError(`${repo} no es un repo git que pueda leer (${(r.stderr || '').trim()})`);
  const seen = new Map();
  for (const rec of r.stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode] = rec.slice(0, tab).split(' ');
    seen.set(rec.slice(tab + 1), mode);
  }
  return [...seen].map(([p, mode]) => ({ path: p, mode }));
}

// ── el control ─────────────────────────────────────────────────────────────────────────────────────────────────
/** La unidad con que se nombra un hallazgo: la carpeta de la skill (skills/x, .agents/skills/x) o la ruta. */
function unitOf(p) {
  const m = /^((?:\.agents\/|\.claude\/)?skills\/[^/]+)/.exec(p);
  return m ? m[1] : p;
}

// La copia pública de un solo repo (story 8.7, AC 11) trae el arnés en la misma raíz que agent-skills: se reconoce por
// este mismo control versionado en su lugar del arnés. Ahí sólo se mira lo que aporta agent-skills.
const AREA_AGENT_SKILLS = /^(?:skills|agents|packs|\.agents|\.claude)\//;
const DEL_ARNES = 'scripts/publishing/third-party-coverage.js';

function checkCoverage({ repo, manifest, skipContent = false }) {
  const findings = [];
  const notes = [];
  const versionados = listVersioned(repo);
  const repoUnico = versionados.some((f) => f.path === DEL_ARNES);
  const files = repoUnico ? versionados.filter((f) => AREA_AGENT_SKILLS.test(f.path)) : versionados;
  const byTarget = new Map(manifest.thirdParty.map((e) => [e.target, e]));
  const derivedHere = manifest.derived.filter((d) => d.repo === 'agent-skills');
  const derivedByTarget = new Map(derivedHere.map((d) => [d.target, d]));
  const declaredLinks = new Map();
  for (const e of manifest.thirdParty) for (const l of e.links || []) declaredLinks.set(l, e);

  const undeclared = new Map();
  const doubled = new Map();
  for (const f of files) {
    const anc = ancestors(f.path);
    const universes = [];
    // una derivada declarada por su ruta exacta gana sobre un patrón de las propias (story 8.7: la copia publica una
    // derivada renombrada que también cae en `skills/tycon-*`); dos declaraciones exactas siguen siendo un hallazgo
    const esDerivada = anc.some((a) => derivedByTarget.has(a));
    if (!esDerivada && manifest.own.some((o) => anc.some((a) => o.re.test(a)))) universes.push('own');
    if (esDerivada) universes.push('derived');
    if (anc.some((a) => byTarget.has(a)) || declaredLinks.has(f.path)) universes.push('third_party');
    const unit = unitOf(f.path);
    if (universes.length === 0) undeclared.set(unit, (undeclared.get(unit) || 0) + 1);
    else if (universes.length > 1) doubled.set(`${unit} → ${universes.join(' y ')}`, (doubled.get(`${unit} → ${universes.join(' y ')}`) || 0) + 1);

    if (f.mode === '120000') {
      const owner = declaredLinks.get(f.path);
      if (owner && manifest.retirement === 'pending') notes.push(`${f.path}: enlace simbólico declarado en ${owner.target}; sale con el retiro`);
      else findings.push(`${f.path}: enlace simbólico versionado${owner ? ' (el retiro ya se hizo: no puede seguir en el árbol)' : ''} — un enlace depende de dónde vive el repo en cada máquina; se declara o se borra`);
    } else if (declaredLinks.has(f.path)) {
      findings.push(`${f.path}: declarado como enlace en ${declaredLinks.get(f.path).target}, pero no es un enlace simbólico (es un archivo común): se corrige el manifiesto o el archivo`);
    }
  }
  for (const [unit, n] of undeclared) findings.push(`${unit}: sin declarar en ningún universo (${n} archivo${n === 1 ? '' : 's'}) — si es ajena, va a third_party en ${path.basename(manifest.file)} con su origen, commit y árbol`);
  for (const [what, n] of doubled) findings.push(`${what.replace(' → ', ': en dos universos (')}) — ${n} archivo${n === 1 ? '' : 's'}; cada ruta cae en uno solo`);

  // declaraciones muertas y retiros a medias
  const versionedUnder = (target) => files.some((f) => isUnder(f.path, target));
  for (const d of derivedHere) {
    if (!versionedUnder(d.target)) findings.push(`${d.target}: declaración muerta — la derivada no está versionada en agent-skills`);
  }
  const toCheckIgnore = [];
  for (const e of manifest.thirdParty) {
    const versioned = versionedUnder(e.target);
    if (manifest.retirement === 'pending') {
      if (!versioned) findings.push(`${e.target}: declaración muerta — con el retiro pendiente tendría que estar versionado y no lo está`);
    } else {
      if (versioned) findings.push(`${e.target}: retiro incompleto — el retiro está hecho y todavía está versionado`);
      else toCheckIgnore.push(e.target);
      for (const l of e.links || []) if (files.some((f) => f.path === l)) findings.push(`${l}: retiro incompleto — el enlace de ${e.target} todavía está versionado`);
    }
  }
  if (toCheckIgnore.length) {
    // Dos sondas por destino —la ruta misma (un archivo, o un patrón sin barra) y un archivo sin extensión adentro (un
    // patrón de carpeta `skills/x/` no matchea una carpeta que no existe en el disco)— y sólo cuenta un patrón de un
    // .gitignore DEL REPO: el `info/exclude` o el excludesFile global de una máquina no viajan a las demás, y un `*.md`
    // no ignora la carpeta de una skill. `--no-index`: un destino forzado a versionar igual se juzga por el .gitignore.
    const PROBE = 'tycon-ignore-probe';
    const probes = toCheckIgnore.flatMap((t) => [t, `${t}/${PROBE}`]);
    const r = git(repo, ['check-ignore', '--no-index', '-v', '-z', '--stdin'], `${probes.join('\0')}\0`);
    if (r.status > 1) throw new ManifestError(`git check-ignore falló (${(r.stderr || '').trim()})`);
    const f = r.stdout.split('\0');
    const ignoredByRepo = new Set();
    for (let i = 0; i + 3 < f.length; i += 4) {
      const [source, , pattern, p] = [f[i], f[i + 1], f[i + 2], f[i + 3]];
      if (source && !path.isAbsolute(source) && path.basename(source) === '.gitignore' && !pattern.startsWith('!')) ignoredByRepo.add(p);
    }
    for (const t of toCheckIgnore) {
      if (!ignoredByRepo.has(t) && !ignoredByRepo.has(`${t}/${PROBE}`)) findings.push(`${t}: retiro incompleto — no está en el .gitignore de agent-skills: lo restituido aparecería como pendiente de commitear`);
    }
  }

  // contenido: con el retiro pendiente, el manifiesto describe lo que hay hoy (AC 5)
  let contentChecked = 0;
  if (!skipContent && manifest.retirement === 'pending') {
    const downloads = manifest.thirdParty.filter((e) => e.install === 'download');
    const r = git(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], downloads.map((e) => `HEAD:${e.target}`).join('\n') + '\n');
    if (r.status !== 0) throw new ManifestError(`git cat-file falló (${(r.stderr || '').trim()})`);
    const lines = r.stdout.split('\n');
    downloads.forEach((e, i) => {
      const [actual, type] = (lines[i] || '').split(' ');
      contentChecked++;
      if (type !== 'tree') { findings.push(`${e.target}: no hay una carpeta versionada en HEAD para comparar con su árbol`); return; }
      if (actual === e.tree) return;
      const has = git(repo, ['cat-file', '-e', `${e.tree}^{tree}`]).status === 0;
      if (!has) { findings.push(`${e.target}: el contenido de HEAD (${actual.slice(0, 12)}) no es el árbol declarado (${e.tree.slice(0, 12)}), que ni siquiera está en este clon`); return; }
      const d = git(repo, ['diff-tree', '-r', '--name-status', e.tree, actual]);
      const changes = d.stdout.trim().split('\n').filter(Boolean).map((l) => {
        const [st, f] = l.split('\t');
        return `${f} (${{ M: 'distinto', A: 'de más', D: 'faltante' }[st[0]] || st})`;
      });
      const shown = changes.slice(0, 10).join(', ') + (changes.length > 10 ? ` y ${changes.length - 10} más` : '');
      findings.push(`${e.target}: el contenido de HEAD no es el árbol declarado — ${shown || 'cambió el modo de algún archivo'}`);
    });
  }
  return { retirement: manifest.retirement, files: files.length, findings, notes, content_checked: contentChecked };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--repo') a.repo = argv[++i];
    else if (x === '--manifest') a.manifest = argv[++i];
    else if (x === '--skip-content') a.skipContent = true;
    else if (x === '--json') a.json = true;
    else throw new ManifestError(`opción desconocida: ${x}`);
  }
  return a;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const repo = path.resolve(args.repo || require('../lib/skills-dir.js').resolveSkillsDirs().repo);
    const manifest = loadManifest(path.resolve(args.manifest || process.env.TYCON_THIRD_PARTY_MANIFEST || DEFAULT_MANIFEST));
    const r = checkCoverage({ repo, manifest, skipContent: !!args.skipContent });
    if (args.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    else {
      const out = [];
      if (r.findings.length === 0) out.push(`✅ skills de terceros: ${r.files} rutas versionadas, cada una en su universo (retiro ${r.retirement}${r.content_checked ? `, ${r.content_checked} árboles iguales a los declarados` : ''})`);
      else out.push(`🛑 skills de terceros: ${r.findings.length} hallazgo${r.findings.length === 1 ? '' : 's'} en agent-skills`, ...r.findings.map((f) => `   · ${f}`));
      for (const n of r.notes) out.push(`   ℹ ${n}`);
      process.stdout.write(`${out.join('\n')}\n`);
    }
    process.exit(r.findings.length === 0 ? 0 : 1);
  } catch (e) {
    const detail = e instanceof ManifestError ? e.message : (e.stack || String(e));
    process.stderr.write(`⛔ third-party-coverage: no pude mirar — ${detail}\n`);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { loadManifest, validateManifest, resolveEntry, checkCoverage, listVersioned, globToRegex, ManifestError, DEFAULT_MANIFEST, LICENSES };
