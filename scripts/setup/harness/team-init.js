'use strict';
// team-init.js — el alta guiada de una organización: `harness.js team-init` (story 8.40, tanda B · AC 21 a 25 y 29).
//
// Qué resuelve: una organización nueva necesita su repo del perfil del equipo (los tres archivos obligatorios de la capa:
// team-layer.json, team-profile.json y team-repos.json) antes de que nadie pueda instalar con `--team`. Copiar el ejemplo
// publicado a mano y cambiar `acme` en cada lugar es fácil de romper. Esto pregunta lo que falta (nombre, plataforma,
// dirección del repo, carpeta), baja el ejemplo publicado (`harness-team-profile-example`, por las rutas públicas:
// info/refs y codeload, sin git y sin permiso), arma los tres archivos con lo contestado y los VALIDA con los mismos
// lectores con que el arnés apila la capa (team.js: la declaración, el perfil, team-repos.js), cargados del árbol
// INSTALADO, como team-config.js. Nada se escribe si algo no valida: un ejemplo con una clave que esta versión no conoce
// se dice, no se adivina (AC 25).
//
// No crea repos ni pide credenciales (decisión 9 de la story): dice dónde crear el repo vacío; si hay git y la persona
// dice que sí, lo sube con el git de la máquina (su credencial, la de siempre); si no, imprime los dos comandos. Con el
// push hecho, ofrece instalar esta máquina con el perfil (`install --version <la instalada> --team <repo>`).
//
// TYCON_TEAM_EXAMPLE_REPO (org/repo): de dónde bajar el ejemplo. SÓLO PRUEBAS (el ejemplo de juguete de
// scripts/tests/harness-team-init.test.sh); las bases de las rutas públicas son las de public-git.js.
// Casos: scripts/tests/harness-team-init.test.sh (T25 a T31).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EXAMPLE_REPO = 'TYCON-SA/harness-team-profile-example';
const FILES = Object.freeze(['team-layer.json', 'team-profile.json', 'team-repos.json']);
const GIT_TIMEOUT_MS = 120 * 1000;
// la línea para el resto del equipo es la de los guiones de entrada con --team: la de npx se imprime recién cuando el
// paquete esté publicado (llega en su propio cambio, junto con la portada)
const teamLines = (repo) => [`bash get-harness.sh -- --team ${repo}`, `pwsh -File get-harness.ps1 -- --team ${repo}`];
// los guiones de entrada NO piden el permiso del repo del equipo (sólo el del arnés): se dice cómo llega, no se promete
// que se pida (pase adversarial, clase 12). GitHub: la variable, que el guion guarda; Azure: el gestor de credenciales de git
const teamCredential = (src) => (src.host === 'azure'
  ? `su credencial de Azure DevOps de LECTURA de ese repo en el gestor de credenciales de git (un git clone ${src.url} una vez la deja guardada); el guion no la pide`
  : 'su permiso de GitHub de LECTURA de ese repo (Fine-grained, Contents: read) en TYCON_GITHUB_TOKEN al correr la línea: el guion no lo pide, lo guarda');

const fail = (code, line) => ({ code, lines: [`harness.js team-init: ${line}`] });
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const fmt = (j) => `${JSON.stringify(j, null, 2)}\n`;
const fromTree = (tree, rel) => require(path.join(tree, ...rel.split('/')));

/** Una respuesta de la terminal; `null` si no hay terminal o la entrada se terminó. */
function ask(P, out, question) {
  if (!P.isTerminal()) return null;
  out(question);
  const a = P.readAnswer();
  return a.eof ? null : a.text.trim();
}

/** El repo de un `team-repos.json` desde lo que acepta `--team` (parseTeam de team.js). */
function repoEntry(src, repoName = src.name) {
  return src.host === 'azure' ? { platform: 'azure', org: src.org, project: src.project, repo: repoName } : { platform: 'github', org: src.org, repo: repoName };
}

/** El repo público del arnés que instaló esta máquina (el estado; si no, la lista del árbol), o null. */
function publicRepoOf(state, tree) {
  const src = (state && Array.isArray(state.sources) ? state.sources : []).find((s) => s && s.kind === 'release');
  const candidates = [src && src.url];
  try { candidates.push(...(JSON.parse(fs.readFileSync(path.join(tree, 'scripts', 'setup', 'public-remotes.json'), 'utf8')).remotes || [])); } catch (_) { /* sin la lista */ }
  for (const u of candidates) {
    const m = /github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(String(u || ''));
    if (m) return { platform: 'github', org: m[1], repo: m[2] };
  }
  return null;
}

/** Los tres archivos del ejemplo publicado, en memoria: `{ ok, files: { nombre: texto } }` o `{ ok: false, reason }`. */
function fetchExample(tree, env) {
  const PG = fromTree(tree, 'scripts/setup/harness/public-git.js');
  const HG = fromTree(tree, 'scripts/lib/http-get.js');
  const TR = fromTree(tree, 'scripts/lib/tar-reader.js');
  const repo = String(env.TYCON_TEAM_EXAMPLE_REPO || EXAMPLE_REPO);
  const b = PG.bases(env);
  if (!b) return { ok: false, reason: 'las rutas públicas de GitHub no están disponibles en este entorno (TYCON_RELEASE_API sin TYCON_RELEASE_GIT)' };
  const refs = HG.getSync(PG.refsUrl(b, repo), { env, timeoutMs: 30000, headers: { Accept: '*/*' } });
  if (!refs.ok || refs.status !== 200) return { ok: false, reason: `no pude mirar el ejemplo ${repo} (${refs.ok ? `GitHub contestó ${refs.status}` : refs.message})` };
  const parsed = PG.parseInfoRefs(refs.body);
  const sha = parsed.ok && parsed.heads.main;
  if (!sha) return { ok: false, reason: `el ejemplo ${repo} no tiene la rama main (${parsed.reason || 'sin main'})` };
  const tar = HG.getSync(PG.tarUrl(b, repo, sha), { env, timeoutMs: 60000, maxBytes: 16 * 1024 * 1024, headers: { Accept: '*/*' } });
  if (!tar.ok || tar.status !== 200) return { ok: false, reason: `no pude bajar el ejemplo ${repo} (${tar.ok ? `GitHub contestó ${tar.status}` : tar.message})` };
  let plan;
  try { plan = TR.plan(TR.parseTarGz(tar.body).entries, { stripRoot: true }); } catch (e) { return { ok: false, reason: `el comprimido del ejemplo no se lee: ${e.message}` }; }
  if (!plan.ok) return { ok: false, reason: `el comprimido del ejemplo no se usa: ${plan.reason}` };
  const files = {};
  for (const f of plan.files) if (FILES.includes(f.path)) files[f.path] = Buffer.from(f.content).toString('utf8');
  const missing = FILES.filter((f) => files[f] === undefined);
  if (missing.length) return { ok: false, reason: `el ejemplo ${repo} no trae ${missing.join(', ')}: esta versión del arnés no sabe armar el perfil con lo que trae` };
  return { ok: true, files, repo, sha };
}

/** Cambia el nombre del ejemplo por el de la organización en los comentarios (`__doc`), nunca en los valores. */
function renameDocs(node, from, to) {
  if (Array.isArray(node)) return node.map((x) => renameDocs(x, from, to));
  if (!isObject(node)) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = k.startsWith('__') && typeof v === 'string' && from ? v.split(from).join(to) : renameDocs(v, from, to);
  return out;
}

/** Los tres archivos armados desde el ejemplo con lo contestado (todo lo demás del ejemplo queda tal cual, para que el lector lo juzgue). */
function build(example, { name, src, version, publicRepo }) {
  const parse = (f) => { try { return { ok: true, j: JSON.parse(example[f].replace(/^﻿/, '')) }; } catch (e) { return { ok: false, reason: `${f} del ejemplo no es JSON (${e.message})` }; } };
  const parsed = {};
  for (const f of FILES) { const p = parse(f); if (!p.ok) return p; if (!isObject(p.j)) return { ok: false, reason: `${f} del ejemplo no es un objeto` }; parsed[f] = p.j; }
  const was = typeof parsed['team-layer.json'].name === 'string' ? parsed['team-layer.json'].name : '';
  const layer = Object.assign({}, parsed['team-layer.json'], { schema: 1, name, requires: Object.assign({}, parsed['team-layer.json'].requires, { harness: `>= ${version}` }) });
  const profile = renameDocs(parsed['team-profile.json'], was, name);
  profile.install = Object.assign({}, profile.install, { profile: 'minimal' });
  profile.update = Object.assign({}, profile.update, { apply: 'ask' });
  // la organización codificada, como en la URL del repo que arma parseTeam (el lector de ado.org la guarda tal cual)
  if (src.host === 'azure') profile.ado = Object.assign({}, isObject(profile.ado) ? profile.ado : {}, { org: `https://dev.azure.com/${encodeURIComponent(src.org)}` });
  else delete profile.ado;
  const repos = renameDocs(parsed['team-repos.json'], was, name);
  repos.version = 1;
  if (publicRepo) repos.public = publicRepo;
  repos.profile = repoEntry(src);
  // `operations` es obligatorio para el lector de team-repos.js: el repo de operaciones va al lado del perfil, con el
  // nombre del ejemplo (la persona lo crea cuando arme los procesos de la noche; hasta entonces nadie lo lee)
  const opsName = isObject(repos.operations) && typeof repos.operations.repo === 'string' ? repos.operations.repo : 'harness-team-operations';
  repos.operations = repoEntry(src, opsName);
  return { ok: true, texts: { 'team-layer.json': fmt(layer), 'team-profile.json': fmt(profile), 'team-repos.json': fmt(repos) } };
}

/** Los tres, con los lectores del árbol instalado; el primer problema, con el archivo y el campo. */
function validate(T, texts, { tree, version, home, env }) {
  const d = T.validateDeclaration(texts['team-layer.json'], version);
  if (!d.ok) return d;
  const p = T.validateProfile(texts['team-profile.json'], { readerTree: tree, home, env, name: 'team-profile.json' });
  if (!p.ok) return p;
  return T.validateTeamRepos(texts['team-repos.json'], { readerTree: tree });
}

function hasGit(env) {
  const r = spawnSync('git', ['--version'], { env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return !r.error && r.status === 0;
}
function git(dir, args, env) {
  const r = spawnSync('git', ['-C', dir, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS });
  // un git que no arrancó o que cortó una señal se dice como tal (nunca un error vacío)
  const why = r.error ? `no arrancó: ${r.error.code || r.error.message}` : r.signal ? `cortado con la señal ${r.signal}` : '';
  return { ok: !r.error && !r.signal && r.status === 0, err: [String(r.stderr || '').trim().split('\n').slice(-2).join(' '), why].filter(Boolean).join(' · ') };
}

function run(ctx) {
  const { tree, home, env, opts, state, version } = ctx;
  const out = (s) => process.stdout.write(`${s}\n`);
  const P = require('./prompt.js');
  const T = fromTree(tree, 'scripts/setup/harness/team.js');
  const dry = Boolean(opts['dry-run']);

  // ── lo que falta, preguntado (o por opción) ──
  let name = opts.name !== undefined ? String(opts.name) : ask(P, out, 'el nombre de la organización (letras sin tilde, números, punto, guion; sin espacios): ');
  if (name === null) return fail(2, 'falta el nombre de la organización: pasá --name <org> (o corrélo en una terminal)');
  const nameCheck = T.validateDeclaration(fmt({ schema: 1, name, requires: { harness: `>= ${version}` } }), version);
  if (!nameCheck.ok) return fail(2, `el nombre «${name}» no sirve: ${nameCheck.reason}`);
  let platform = opts.platform !== undefined ? String(opts.platform) : ask(P, out, '¿dónde vive el repo del perfil? github o azure: ');
  if (platform === null) return fail(2, 'falta la plataforma: pasá --platform github|azure');
  platform = platform.toLowerCase();
  if (!['github', 'azure'].includes(platform)) return fail(2, `la plataforma es github o azure (dice «${platform}»)`);
  const shape = platform === 'github' ? 'org/repo de GitHub' : 'https://dev.azure.com/<org>/<proyecto>/_git/<repo>';
  const addr = opts['profile-repo'] !== undefined ? String(opts['profile-repo']) : ask(P, out, `la dirección del repo del perfil (${shape}): `);
  if (addr === null) return fail(2, `falta la dirección del repo del perfil: pasá --profile-repo <${shape}>`);
  const src = T.parseTeam(addr);
  if (!src.ok) return fail(2, src.problem.replace(/^--team/, 'la dirección del repo del perfil'));
  if ((src.host === 'azure') !== (platform === 'azure')) return fail(2, `la dirección «${addr}» no es de ${platform}: ${shape}`);
  const defDir = path.join(home, src.name);
  let dir = opts.dir !== undefined ? String(opts.dir) : ask(P, out, `la carpeta donde dejo los archivos [${defDir}]: `);
  dir = path.resolve(String(dir || defDir).replace(/^~(?=[\\/]|$)/, home));
  if (fs.existsSync(dir)) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return fail(2, `la carpeta ${dir} no se puede usar (${e.code || e.message})`); }
    if (entries.length) return fail(1, `la carpeta ${dir} ya existe y no está vacía: no la toco. Elegí otra con --dir`);
  }

  // ── el ejemplo, los tres archivos y su validación (nada se escribe antes) ──
  const ex = fetchExample(tree, env);
  if (!ex.ok) return fail(1, `${ex.reason}. No escribí nada.`);
  const built = build(ex.files, { name, src, version, publicRepo: publicRepoOf(state, tree) });
  if (!built.ok) return fail(1, `${built.reason}. No escribí nada.`);
  const v = validate(T, built.texts, { tree, version, home, env });
  if (!v.ok) return fail(1, `${v.reason} — el ejemplo publicado trae algo que esta versión del arnés (${version}) no entiende, o lo armado no vale. No escribí nada; actualizá el arnés (harness.js update) y volvé a correrlo.`);

  if (dry) {
    out(`team-init --dry-run: escribiría en ${dir} (no escribí nada):`);
    for (const f of FILES) { out(`── ${f}`); out(built.texts[f].trimEnd()); }
    return { code: 0, lines: [] };
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return fail(2, `no pude crear la carpeta ${dir} (${e.code || e.message}). No escribí nada.`); }
  for (const f of FILES) fs.writeFileSync(path.join(dir, f), built.texts[f]);

  // ── el resumen y los pasos que siguen ──
  const where = src.host === 'azure' ? 'Azure DevOps' : 'GitHub';
  const e = encodeURIComponent;   // cada segmento, codificado, en toda URL armada (parseTeam ya rechazó «.» y «..»)
  const createAt = src.host === 'azure' ? `https://dev.azure.com/${e(src.org)}/${e(src.project)}/_settings/repositories` : `https://github.com/new?owner=${e(src.org)}&name=${e(src.name)}&visibility=private`;
  const pushUrl = src.host === 'azure' ? src.url : `https://github.com/${e(src.org)}/${e(src.name)}.git`;
  const cmds = [`cd "${dir}" && git init -b main && git add ${FILES.join(' ')} && git commit -m "el perfil del equipo ${name}"`,
    `cd "${dir}" && git remote add origin ${pushUrl} && git push -u origin main`];
  out('');
  out(`listo: el perfil del equipo ${name} quedó en ${dir} (${FILES.join(', ')}), validado con los lectores de esta versión (${version}).`);
  out('lo que sigue:');
  out(`  1. creá el repo privado VACÍO en ${where}, con acceso sólo para tu equipo: ${createAt}`);
  let pushed = false;
  let gitFailed = false;   // con «s», cualquier paso de git que falla (init, add, commit o push) deja el perfil sin subir: sale 1
  const answer = hasGit(env) ? ask(P, out, '  2. ¿Los subo yo con git? [s/N] ') : null;
  if (answer !== null && P.saidYes(answer)) {
    const steps = [['init', '-q'], ['symbolic-ref', 'HEAD', 'refs/heads/main'], ['add', ...FILES], ['commit', '-q', '-m', `el perfil del equipo ${name} (harness.js team-init)`]];
    let bad = null;
    for (const s of steps) { const r = git(dir, s, env); if (!r.ok) { bad = s[0] === 'commit' ? `git no pudo commitear (¿sin identidad? configurá user.name y user.email): ${r.err}` : `git ${s[0]} falló: ${r.err}`; break; } }
    if (!bad) {
      git(dir, ['remote', 'add', 'origin', pushUrl], env);
      const r = git(dir, ['push', '-u', 'origin', 'main'], env);
      if (r.ok) { pushed = true; out(`     subido a ${pushUrl}`); } else bad = `el push a ${pushUrl} falló (${r.err}): ¿el repo ya existe y tu git tiene permiso? El commit local quedó en ${dir}`;
    }
    if (bad) { gitFailed = true; out(`     ${bad}`); out('     cuando el repo exista, subilo con:'); for (const c of cmds) out(`       ${c}`); }
  } else {
    out('  2. subí los archivos con git (pegá estas dos líneas cuando el repo exista):');
    for (const c of cmds) out(`       ${c}`);
  }
  // la ruta del árbol, entre comillas: una carpeta personal con espacios (Windows) rompería la línea pegada (clase 10)
  const installCmd = `node "${path.join(tree, 'scripts', 'setup', 'harness.js')}" install --version ${version} --team ${src.repo}`;
  let installRc = 0;
  if (pushed && P.saidYes(ask(P, out, '  3. ¿Instalo esta máquina con el perfil ahora? [s/N] ') || '')) {
    const r = spawnSync(process.execPath, [path.join(tree, 'scripts', 'setup', 'harness.js'), 'install', '--version', version, '--team', src.repo], { stdio: 'inherit', env, windowsHide: true });
    installRc = r.error || r.signal || r.status === null ? 1 : r.status;
    const why = r.error ? `no arrancó (${r.error.code || r.error.message})` : r.signal ? `se cortó con la señal ${r.signal}` : `salió ${installRc}`;
    if (installRc !== 0) out(`     la instalación con el perfil ${why}: probala de nuevo con ${installCmd}`);
  } else out(`  3. instalá esta máquina con el perfil: ${installCmd}`);
  const [shLine, psLine] = teamLines(src.repo);
  out(`  4. el resto del equipo baja el guion de entrada como dice la portada y lo corre con --team: ${shLine} (Mac y Linux) · ${psLine} (Windows). Cada persona necesita ${teamCredential(src)}. Quien ya tiene el arnés: harness.js install --team ${src.repo}`);
  out(`  5. después, y no es parte del alta: los procesos de la noche (${src.host === 'azure' ? 'pipelines/operations/README.md' : 'pipelines/operations/github/README.md'} del arnés) y la página de configuración de la organización (harness.js team-config).`);
  return { code: gitFailed ? 1 : installRc, lines: [] };
}

module.exports = { run, build, fetchExample, publicRepoOf, FILES, EXAMPLE_REPO };
