'use strict';
// team-init.js — el alta guiada de una organización: `harness.js team-init`.
//
// Qué resuelve: una organización nueva necesita su repo del perfil del equipo (los tres archivos obligatorios de la capa:
// team-layer.json, team-profile.json y team-repos.json) antes de que nadie pueda instalar con `--team`. Copiar el ejemplo
// publicado a mano y cambiar `acme` en cada lugar es fácil de romper. Esto pregunta lo que falta (nombre, plataforma,
// dirección del repo, carpeta), baja el ejemplo publicado (`harness-team-profile-example`, por las rutas públicas:
// info/refs y codeload, sin git y sin permiso), arma los tres archivos con lo contestado y los VALIDA con los mismos
// lectores con que el arnés apila la capa (team.js: la declaración, el perfil, team-repos.js), cargados del árbol
// INSTALADO, como team-config.js. Nada se escribe si algo no valida: un ejemplo con una clave que esta versión no conoce
// se dice, no se adivina.
//
// No crea repos ni pide credenciales: dice dónde crear el repo vacío; si hay git y la persona
// dice que sí, lo sube con el git de la máquina (su credencial, la de siempre); si no, imprime los dos comandos. Con el
// push hecho, ofrece instalar esta máquina con el perfil (`install --version <la instalada> --team <repo>`).
//
// Al final ofrece el repo de HISTORIAS del equipo: las plantillas genéricas del núcleo
// (team-stories/, al lado de este archivo en el árbol instalado) llenas y en su lugar, al lado de la carpeta del perfil. Va al final para que
// las respuestas de antes no cambien de orden. `--stories <nombre>` contesta, `--no-stories` lo saltea y `--stories-only`
// arma sólo ese repo (para hacerlo después). Tampoco crea ese repo: imprime los comandos y la política de rama.
//
// TYCON_TEAM_EXAMPLE_REPO (org/repo): de dónde bajar el ejemplo. SÓLO PRUEBAS (el ejemplo de juguete de
// scripts/tests/harness-team-init.test.sh); las bases de las rutas públicas son las de public-git.js.
// Casos: scripts/tests/harness-team-init.test.sh (T25 a T31, T38 y T45); las plantillas: team-stories-templates.test.js (T44).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EXAMPLE_REPO = 'TYCON-SA/harness-team-profile-example';
const FILES = Object.freeze(['team-layer.json', 'team-profile.json', 'team-repos.json']);
const GIT_TIMEOUT_MS = 120 * 1000;
// la línea para el resto del equipo: npx con --team (pide el permiso de lectura del repo del perfil si hace falta, AC 4);
// a mano, sin npm, los guiones de entrada con --team
const NPX_LINE = (repo) => `npx @tyconsa/harness@latest --team ${repo}`;
const teamLines = (repo) => [`bash get-harness.sh -- --team ${repo}`, `pwsh -File get-harness.ps1 -- --team ${repo}`];
// el repo de historias: de dónde salen las plantillas (en el árbol instalado), a dónde va cada una en el repo, y los
// únicos marcadores que se llenan (uno que no está acá quedaría escrito tal cual: se frena antes de escribir)
const STORIES_DIR = 'scripts/setup/harness/team-stories';
const STORIES_MARKERS = Object.freeze(['TEAM', 'STORIES_REPO', 'DATE', 'ADO_ORG_URL', 'ADO_PROJECT', 'ADO_WORK_ITEM_TYPE']);
const STORIES_LAYOUT = Object.freeze({
  common: [['CLAUDE.md', 'CLAUDE.md'], ['README.md', 'README.md'], ['specs-README.md', '.specs/README.md'], ['githooks-pre-commit', '.githooks/pre-commit'], ['tycon-advisors.yaml', '.tycon/advisors.yaml']],
  azure: [['azure/tycon-ado-config.yaml', '.tycon/ado-config.yaml'], ['azure/stories-gate.yml', 'pipelines/stories-gate.yml']],
  github: [['github/stories-gate.yml', '.github/workflows/stories-gate.yml']],
});
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
// el perfil local mínimo, cuando el ejemplo publicado no se puede bajar: la declaración (build le pone el nombre y la
// versión) y un perfil con lo que build fija igual; team-repos.json no se usa en un perfil local
const LOCAL_MINIMUM = Object.freeze({
  'team-layer.json': '{ "schema": 1, "name": "local", "requires": {} }\n',
  'team-profile.json': '{ "__doc": "La configuración de tu perfil local. Las claves son un vocabulario cerrado: una que el arnés no conoce invalida el perfil.", "update": { "channel": "stable", "apply": "ask" }, "install": { "profile": "minimal" } }\n',
  'team-repos.json': '{}\n',
});
// los guiones de entrada NO piden el permiso del repo del equipo (sólo el del arnés): se dice cómo llega, no se promete
// que se pida. GitHub: la variable, que el guion guarda; Azure: el gestor de credenciales de git
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
  // un perfil local no declara repos remotos: sin team-repos.json, que es opcional en la capa
  if (src.host === 'local') return { ok: true, texts: { 'team-layer.json': fmt(layer), 'team-profile.json': fmt(profile) } };
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
  if (texts['team-repos.json'] === undefined) return { ok: true };
  return T.validateTeamRepos(texts['team-repos.json'], { readerTree: tree });
}

function hasGit(env) {
  const r = spawnSync('git', ['--version'], { env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return !r.error && r.status === 0;
}
// ninguna variable de git de quien llama decide en qué repo se escribe (corrido dentro de un hook de git, GIT_DIR apuntaría a
// otro repo)
const GIT_REPO_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX'];
function git(dir, args, env) {
  const clean = Object.assign({}, env);
  for (const k of GIT_REPO_VARS) delete clean[k];
  const r = spawnSync('git', ['-C', dir, ...args], { env: clean, encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS });
  // un git que no arrancó o que cortó una señal se dice como tal (nunca un error vacío)
  const why = r.error ? `no arrancó: ${r.error.code || r.error.message}` : r.signal ? `cortado con la señal ${r.signal}` : '';
  return { ok: !r.error && !r.signal && r.status === 0, err: [String(r.stderr || '').trim().split('\n').slice(-2).join(' '), why].filter(Boolean).join(' · ') };
}

/** El nombre de defecto del repo de historias: el del perfil sin `-profile`, con `-stories`, en la forma que acepta
 * REPO_NAME (en Azure el del perfil puede traer espacios, tildes o paréntesis: el de defecto tiene que servir siempre). */
const storiesDefault = (src) => `${String(src.name).replace(/-profile$/i, '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'team'}-stories`;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Los archivos del repo de historias, en memoria: `{ ok, files: [{ rel, text, mode }] }` o `{ ok: false, reason, absent }`. */
function buildStories(tree, { team, repo, src, date = today() }) {
  const base = path.join(tree, ...STORIES_DIR.split('/'));
  if (!fs.existsSync(base)) return { ok: false, absent: true, reason: `esta versión del arnés no trae las plantillas del repo de historias (${STORIES_DIR}): actualizá el arnés (harness.js update) y armalo después con --stories-only` };
  const vars = { TEAM: team, STORIES_REPO: repo, DATE: date };
  if (src.host === 'azure') Object.assign(vars, { ADO_ORG_URL: `https://dev.azure.com/${encodeURIComponent(src.org)}`, ADO_PROJECT: src.project, ADO_WORK_ITEM_TYPE: 'User Story' });
  const files = [{ rel: 'AGENTS.md', text: '# AGENTS.md\n\nLas reglas de este repo están en [CLAUDE.md](CLAUDE.md).\n', mode: 0o644 }];
  for (const [from, rel] of [...STORIES_LAYOUT.common, ...STORIES_LAYOUT[src.host]]) {
    let text;
    try { text = fs.readFileSync(path.join(base, ...from.split('/')), 'utf8'); } catch (e) { return { ok: false, reason: `falta la plantilla ${STORIES_DIR}/${from} (${e.code || e.message})` }; }
    const filled = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
    const left = [...new Set((filled.match(/\{\{[A-Z0-9_]+\}\}/g) || []))];
    if (left.length) return { ok: false, reason: `la plantilla ${STORIES_DIR}/${from} trae ${left.join(', ')}, que team-init no sabe llenar` };
    files.push({ rel, text: filled, mode: rel === '.githooks/pre-commit' ? 0o755 : 0o644 });
  }
  return { ok: true, files };
}

/** El repo de historias en `dir` (o, con --dry-run, la lista): `{ code }`. Nada se escribe si algo no está bien: se arma al
 * lado y se mueve entero. `asked`: la persona lo pidió (--stories <nombre> o --stories-only): sin plantillas es un 1, no un 0. */
function writeStories(tree, { team, repo, src, dir, dry, out, asked = false }) {
  if (/^no?$/i.test(repo)) return { code: 2, line: `«${repo}» no es un nombre de repo: para no armar el repo de historias, --no-stories` };
  if (!REPO_NAME.test(repo) || /^\.+$/.test(repo)) return { code: 2, line: `el nombre del repo de historias «${repo}» no sirve: letras sin tilde, números, punto, guion o guion bajo` };
  if (fs.existsSync(dir)) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return { code: 2, line: `la carpeta ${dir} no se puede usar (${e.code || e.message})` }; }
    if (entries.length) return { code: 1, line: `la carpeta ${dir} ya existe y no está vacía: no la toco. Elegí otra con --dir (con --stories-only)` };
  }
  const b = buildStories(tree, { team, repo, src });
  if (!b.ok) return { code: b.absent && !asked ? 0 : 1, line: `${b.reason}. No escribí el repo de historias.` };
  if (dry) { out(`  el repo de historias ${repo}, en ${dir} (no escribí nada): ${b.files.map((f) => f.rel).join(', ')}`); return { code: 0 }; }
  const tmp = `${dir}.tmp-${process.pid}`;   // se arma al lado y se mueve entero: una escritura que falla no deja medio repo
  try {
    for (const f of b.files) { const p = path.join(tmp, ...f.rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.text, { mode: f.mode }); fs.chmodSync(p, f.mode); }
    if (fs.existsSync(dir)) fs.rmdirSync(dir);   // existe y está vacía (se miró arriba)
    fs.renameSync(tmp, dir);
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); return { code: 2, line: `no pude escribir el repo de historias en ${dir} (${e.code || e.message}). No escribí nada.` }; }
  const e = encodeURIComponent;
  const createAt = src.host === 'azure' ? `https://dev.azure.com/${e(src.org)}/${e(src.project)}/_settings/repositories` : `https://github.com/new?owner=${e(src.org)}&name=${e(repo)}&visibility=private`;
  const pushUrl = src.host === 'azure' ? `https://dev.azure.com/${e(src.org)}/${e(src.project)}/_git/${e(repo)}` : `https://github.com/${e(src.org)}/${e(repo)}.git`;
  out(`  el repo de historias ${repo} quedó en ${dir}. Para que exista:`);
  out(`     creá el repo privado VACÍO: ${createAt}`);
  out(`       cd "${dir}" && git init -b main && git add -A && git commit -m "el repo de historias de ${team}"`);
  out(`       cd "${dir}" && git remote add origin "${pushUrl}" && git push -u origin main`);   // entre comillas: ( ) ! de Azure
  out(src.host === 'azure'
    ? '     y en la rama main, la política «Build validation» con un pipeline nuevo sobre pipelines/stories-gate.yml (Repos → Branches → main → Branch policies): sin ella el portón no corre'
    : '     y en la regla de main (Settings → Rules), el job «gate» del workflow stories-gate como control requerido: sin él el portón no frena el merge');
  return { code: 0 };
}

/**
 * El perfil de una persona sola, en un repo git de esta máquina sin dirección, sin
 * cuenta y sin team-repos.json. Se arma al lado, con git y un commit en `main`, y se mueve entero: una falla no deja medio
 * repo. Después ofrece instalar con esa carpeta y dice cómo subirlo (la copia de respaldo), sin preguntarlo: la oferta de
 * subirlo la hace el agente, una vez (guides/reviewer-packs.md, «Si trabajás solo»).
 */
function runLocal({ tree, home, env, opts, state, version, name, T, P, out, dry }) {
  if (opts['profile-repo'] !== undefined) return fail(2, 'un perfil local no lleva --profile-repo: vive en una carpeta de esta máquina (--dir)');
  if (opts['stories-only'] || opts.stories !== undefined) return fail(2, 'el repo de historias necesita una plataforma (github o azure): un perfil local no lo arma');
  const defDir = path.join(home, `${name}-profile`);
  let dir = opts.dir !== undefined ? String(opts.dir) : ask(P, out, `la carpeta del perfil, en esta máquina [${defDir}]: `);
  dir = path.resolve(String(dir || defDir).replace(/^~(?=[\\/]|$)/, home));
  if (fs.existsSync(dir)) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return fail(2, `la carpeta ${dir} no se puede usar (${e.code || e.message})`); }
    if (entries.length) return fail(1, `la carpeta ${dir} ya existe y no está vacía: no la toco. Elegí otra con --dir`);
  }
  if (!dry && !hasGit(env)) return fail(1, 'el perfil local vive en un repo git de esta máquina y no encuentro git: instalalo y volvé a correrlo. No escribí nada.');
  const src = { host: 'local', name: path.basename(dir), repo: dir };
  // sin el ejemplo publicado (sin red, o GitHub no contesta) el perfil local sale del mínimo que trae esta versión: un
  // perfil de una persona sola no necesita nada de la red, y el lector lo juzga igual
  let ex = fetchExample(tree, env);
  if (!ex.ok) {
    out(`team-init --local: ${ex.reason}; armo el perfil mínimo de esta versión, sin el ejemplo publicado`);
    ex = { ok: true, files: LOCAL_MINIMUM };
  }
  const built = build(ex.files, { name, src, version, publicRepo: null });
  if (!built.ok) return fail(1, `${built.reason}. No escribí nada.`);
  const v = validate(T, built.texts, { tree, version, home, env });
  if (!v.ok) return fail(1, `${v.reason} — el ejemplo publicado trae algo que esta versión del arnés (${version}) no entiende. No escribí nada; actualizá el arnés (harness.js update) y volvé a correrlo.`);
  const files = Object.keys(built.texts);
  if (dry) {
    out(`team-init --local --dry-run: escribiría en ${dir}, con git y un commit en main (no escribí nada):`);
    for (const f of files) { out(`── ${f}`); out(built.texts[f].trimEnd()); }
    return { code: 0, lines: [] };
  }
  let tmp = null;
  try {
    // la temporal al lado, con nombre que nadie puede adivinar (un enlace plantado en <dir>.tmp-<pid> se seguiría);
    // el repo nace con objetos sha1, el formato que lee el arnés (un init.defaultObjectFormat=sha256
    // global armaría un perfil que install --team no lee)
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    tmp = fs.mkdtempSync(path.join(path.dirname(dir), `.${path.basename(dir)}.tmp-`));
    for (const f of files) fs.writeFileSync(path.join(tmp, f), built.texts[f]);
    for (const s of [['-c', 'init.defaultObjectFormat=sha1', 'init', '-q'], ['symbolic-ref', 'HEAD', 'refs/heads/main'], ['add', ...files], ['commit', '-q', '-m', `el perfil de ${name} (harness.js team-init --local)`]]) {
      const r = git(tmp, s, env);
      const verb = s.find((x) => !x.startsWith('-') && !x.includes('='));
      if (!r.ok) throw new Error(verb === 'commit' ? `git no pudo commitear (¿sin identidad? configurá user.name y user.email): ${r.err}` : `git ${verb} falló: ${r.err}`);
    }
    if (fs.existsSync(dir)) fs.rmdirSync(dir);   // existe y está vacía (se miró arriba)
    fs.renameSync(tmp, dir);
  } catch (e) {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    return fail(1, `${e.message || e.code}. No escribí nada.`);
  }
  out('');
  out(`listo: el perfil de ${name} quedó en ${dir} (${files.join(', ')}), en un repo git de esta máquina con un commit en main, validado con los lectores de esta versión (${version}).`);
  out('lo que sigue:');
  const installArgs = ['install', '--version', version, '--team', dir];
  const installCmd = `node "${path.join(tree, 'scripts', 'setup', 'harness.js')}" install --version ${version} --team "${dir}"`;
  let installRc = 0;
  if (P.saidYes(ask(P, out, '  1. ¿Instalo esta máquina con el perfil ahora? [s/N] ') || '')) {
    const r = spawnSync(process.execPath, [path.join(tree, 'scripts', 'setup', 'harness.js'), ...installArgs], { stdio: 'inherit', env, windowsHide: true });
    installRc = r.error || r.signal || r.status === null ? 1 : r.status;
    if (installRc !== 0) out(`     la instalación con el perfil salió ${installRc}: probala de nuevo con ${installCmd}`);
  } else out(`  1. instalá esta máquina con el perfil: ${installCmd}`);
  out(`  2. tus paquetes de revisores van en ${path.join(dir, 'packs', '<nombre>')}${path.sep}, activados en team-profile.json (packs.default) y con un commit; después, harness.js update. El paso a paso: guides/reviewer-packs.md del arnés, «Si trabajás solo».`);
  out('  3. sin copia de respaldo: el perfil vive sólo en esta máquina. Para tenerla, subilo a GitHub o a Azure DevOps: creá el repo privado VACÍO y, desde la carpeta,');
  out(`       cd "${dir}" && git remote add origin "<dirección del repo>" && git push -u origin main`);
  out('     y después harness.js install --team <dirección del repo>, para que el arnés lo lea de ahí.');
  return { code: installRc, lines: [] };
}

function run(ctx) {
  const { tree, home, env, opts, state, version } = ctx;
  const out = (s) => process.stdout.write(`${s}\n`);
  const P = require('./prompt.js');
  const T = fromTree(tree, 'scripts/setup/harness/team.js');
  const dry = Boolean(opts['dry-run']);
  const storiesOnly = Boolean(opts['stories-only']);
  if (opts['no-stories'] && (storiesOnly || opts.stories !== undefined)) return fail(2, `--no-stories no va con ${storiesOnly ? '--stories-only' : '--stories'}`);

  // ── lo que falta, preguntado (o por opción) ──
  let name = opts.name !== undefined ? String(opts.name) : ask(P, out, 'el nombre de la organización (letras sin tilde, números, punto, guion; sin espacios): ');
  if (name === null) return fail(2, 'falta el nombre de la organización: pasá --name <org> (o corrélo en una terminal)');
  const nameCheck = T.validateDeclaration(fmt({ schema: 1, name, requires: { harness: `>= ${version}` } }), version);
  if (!nameCheck.ok) return fail(2, `el nombre «${name}» no sirve: ${nameCheck.reason}`);
  if (opts.local && opts.platform !== undefined && String(opts.platform).toLowerCase() !== 'local') return fail(2, `--local no va con --platform ${opts.platform}`);
  let platform = opts.local ? 'local' : opts.platform !== undefined ? String(opts.platform) : ask(P, out, '¿dónde vive el repo del perfil? github, azure o local (sólo en esta máquina, para una persona sola): ');
  if (platform === null) return fail(2, 'falta la plataforma: pasá --platform github|azure, o --local');
  platform = platform.toLowerCase();
  if (!['github', 'azure', 'local'].includes(platform)) return fail(2, `la plataforma es github, azure o local (dice «${platform}»)`);
  if (platform === 'local') return runLocal({ tree, home, env, opts, state, version, name, T, P, out, dry });
  const shape = platform === 'github' ? 'org/repo de GitHub' : 'https://dev.azure.com/<org>/<proyecto>/_git/<repo>';
  const addr = opts['profile-repo'] !== undefined ? String(opts['profile-repo']) : ask(P, out, `la dirección del repo del perfil (${shape}): `);
  if (addr === null) return fail(2, `falta la dirección del repo del perfil: pasá --profile-repo <${shape}>`);
  const src = T.parseTeam(addr);
  if (!src.ok) return fail(2, src.problem.replace(/^--team/, 'la dirección del repo del perfil'));
  // la dirección tiene que ser de la plataforma pedida: una carpeta de esta máquina (`host: 'local'`) con github o
  // azure armaría un perfil remoto sin team-repos.json y a medias
  if (src.host === 'local') return fail(2, `«${addr}» es una carpeta de esta máquina, no un repo de ${platform}: para un perfil local, team-init --local (--dir <carpeta>)`);
  if (src.host !== platform) return fail(2, `la dirección «${addr}» no es de ${platform}: ${shape}`);
  if (storiesOnly) {   // sólo el repo de historias, para armarlo después del perfil (o sin él)
    let repo = opts.stories !== undefined ? String(opts.stories) : ask(P, out, `el nombre del repo de historias [${storiesDefault(src)}]: `);
    repo = repo || storiesDefault(src);
    const where = opts.dir !== undefined ? path.resolve(String(opts.dir).replace(/^~(?=[\\/]|$)/, home)) : path.join(home, repo);
    const r = writeStories(tree, { team: name, repo, src, dir: where, dry, out, asked: true });
    return r.line ? fail(r.code, r.line) : { code: r.code, lines: [] };
  }
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
    if (opts.stories !== undefined && !opts['no-stories']) {
      const r = writeStories(tree, { team: name, repo: String(opts.stories), src, dir: path.join(path.dirname(dir), String(opts.stories)), dry: true, out, asked: true });
      if (r.line) return fail(r.code, r.line);
    }
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
    `cd "${dir}" && git remote add origin "${pushUrl}" && git push -u origin main`];   // entre comillas: ( ) ! de Azure
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
  // la ruta del árbol, entre comillas: una carpeta personal con espacios (Windows) rompería la línea pegada
  const installCmd = `node "${path.join(tree, 'scripts', 'setup', 'harness.js')}" install --version ${version} --team ${src.repo}`;
  let installRc = 0;
  if (pushed && P.saidYes(ask(P, out, '  3. ¿Instalo esta máquina con el perfil ahora? [s/N] ') || '')) {
    const r = spawnSync(process.execPath, [path.join(tree, 'scripts', 'setup', 'harness.js'), 'install', '--version', version, '--team', src.repo], { stdio: 'inherit', env, windowsHide: true });
    installRc = r.error || r.signal || r.status === null ? 1 : r.status;
    const why = r.error ? `no arrancó (${r.error.code || r.error.message})` : r.signal ? `se cortó con la señal ${r.signal}` : `salió ${installRc}`;
    if (installRc !== 0) out(`     la instalación con el perfil ${why}: probala de nuevo con ${installCmd}`);
  } else out(`  3. instalá esta máquina con el perfil: ${installCmd}`);
  const [shLine, psLine] = teamLines(src.repo);
  out(`  4. el resto del equipo corre ${NPX_LINE(src.repo)} (si su máquina no ve el repo del perfil, le pide el permiso de lectura). A mano, sin npm: ${shLine} (Mac y Linux) · ${psLine} (Windows); con los guiones, cada persona necesita ${teamCredential(src)}. Quien ya tiene el arnés: harness.js install --team ${src.repo}`);
  out(`  5. después, y no es parte del alta: los procesos de la noche (${src.host === 'azure' ? 'pipelines/operations/README.md' : 'pipelines/operations/github/README.md'} del arnés) y la página de configuración de la organización (harness.js team-config).`);
  // ── 6. el repo de historias, al final (las respuestas de antes no cambian de orden) ──
  let storiesRc = 0;
  if (!opts['no-stories']) {
    const def = storiesDefault(src);
    const answer = opts.stories !== undefined ? String(opts.stories) : ask(P, out, `  6. ¿Armo también el repo de historias del equipo, con su portón? El nombre [${def}], o «no»: `);
    const flags = `--name ${name} --platform ${platform} --profile-repo "${src.repo}"`;
    const asked = opts.stories !== undefined;   // por opción, «no» es un nombre que no sirve (lo dice writeStories); en la terminal, saltea
    if (answer === null) out(`  6. el repo de historias del equipo, con su portón, cuando quieras: harness.js team-init --stories-only ${flags} [--stories <nombre>] [--dir <carpeta>]`);
    else if (asked || !/^no?$/i.test(answer)) {
      const repo = answer || def;
      const r = writeStories(tree, { team: name, repo, src, dir: path.join(path.dirname(dir), repo), dry: false, out, asked });
      if (r.line) { out(`  6. ${r.line}`); storiesRc = r.code; }
    }
  }
  return { code: gitFailed ? 1 : installRc || storiesRc, lines: [] };
}

module.exports = { run, build, fetchExample, publicRepoOf, buildStories, FILES, EXAMPLE_REPO, STORIES_MARKERS, STORIES_DIR };
