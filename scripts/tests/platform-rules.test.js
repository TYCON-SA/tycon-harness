'use strict';
// platform-rules.test.js — las reglas de cada plataforma viajan con su conector y aparecen a demanda.
//
// Lo que no se puede perder:
//   · la regla de los listados de Azure DevOps ya no está en los bloques del CLAUDE.md: vive en el conector, y su bloque
//     está en la lista de retirados, así una máquina que ya lo tiene escrito lo pierde en la próxima actualización (en
//     el CLAUDE.md y en el AGENTS.md), sin tocar lo que la persona escribió alrededor;
//   · el gancho de avisos de extensiones dice las reglas de una plataforma junto con el resultado del primer comando de
//     su CLI (el evento después de la herramienta: el canal que llega al modelo), una vez por sesión, y nunca frena;
//   · sólo las de una plataforma que la organización eligió para algo (el perfil, un repo declarado, el repo de
//     operaciones, o `ado.org` en la máquina): una organización con GitHub no ve las de Azure DevOps, y al revés.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'extension-notices.js');
const PLATFORM = path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js');
const SYNC = path.join(ROOT, 'scripts', 'setup', 'sync-claude-md-blocks.sh');
const BLOCKS = path.join(ROOT, 'claude-md-blocks');
const ADO = path.join(ROOT, 'integrations', 'azure-devops');
const GH = path.join(ROOT, 'integrations', 'github');
const RETIRED = 'ado-runs-list-lag';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const read = (f) => fs.readFileSync(f, 'utf8');
// el primer renglón con texto de las reglas de cada conector: lo que el gancho tiene que haber dicho
const primerRenglon = (f) => read(f).split('\n').find((l) => l.trim() && !/^<!--/.test(l) && !/^#/.test(l)).trim();

/**
 * Una organización de laboratorio: su perfil (`platform`), su team-repos.json (`teamRepos`), `ado.org` en la máquina
 * (`adoOrg`), una copia de los dos conectores (para poder romper sus avisos), un repo donde trabaja la sesión y una
 * carpeta de paquetes vacía.
 */
function org({ platform, teamRepos, adoOrg, perfilRoto = false } = {}) {
  const tree = tmp('arbol-'); const home = tmp('casa-'); const ints = tmp('integraciones-'); const repo = tmp('repo-');
  fs.writeFileSync(path.join(tree, 'team-profile.json'), perfilRoto ? '{ esto no es JSON' : JSON.stringify(platform === undefined ? {} : { integrations: { platform } }));
  if (teamRepos) fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify(teamRepos));
  for (const c of ['azure-devops', 'github']) fs.cpSync(path.join(ROOT, 'integrations', c), path.join(ints, c), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_TREE: tree, TYCON_HOME: path.join(home, '.tycon'), TYCON_INTEGRATIONS_DIR: ints, TYCON_PACKS_DIR: tmp('paquetes-') };
  // lo que trae quien corre la prueba no entra: una organización o una plataforma de su máquina cambiaría la elección
  for (const k of Object.keys(env)) if (/^TYCON_(ADO_ORG|ADO_PROJECT|PLATFORM|PROFILE|EXTENSION_NOTICES)$|^ADO_ORG$/.test(k)) delete env[k];
  if (adoOrg) env.TYCON_ADO_ORG = adoOrg;
  return { tree, home, ints, repo, env };
}

/** El gancho con un evento; devuelve la salida leída: `{status, ctx, raw, json}`. */
function gancho(o, event) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: o.repo, ...event }), env: o.env, encoding: 'utf8' });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch (_) { json = null; }
  const ctx = json && json.hookSpecificOutput ? String(json.hookSpecificOutput.additionalContext || '') : '';
  return { status: r.status, ctx, raw: r.stdout, json };
}
const bash = (session, command, extra = {}) => ({ session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });
const sinDecision = (r) => {
  assert.strictEqual(r.status, 0, r.raw);
  const t = JSON.stringify(r.json || {});
  assert.ok(!/"decision"|permissionDecision/.test(t), `nunca frena: ${t}`);
};
const dijoAdo = (r) => r.ctx.includes(primerRenglon(path.join(ADO, 'rules.md')));
const dijoGh = (r) => r.ctx.includes(primerRenglon(path.join(GH, 'rules.md')));

test('Rules_TravelWithConnector_NotInGlobalBlocks @story-8.85 @ac-34', () => {
  // el bloque se fue de los bloques del CLAUDE.md, y quedó en la lista de retirados con su motivo
  assert.ok(!fs.existsSync(path.join(BLOCKS, `${RETIRED}.md`)), 'el bloque de Azure DevOps no está en claude-md-blocks/');
  const retired = JSON.parse(read(path.join(BLOCKS, 'retired.json')));
  assert.ok(typeof retired[RETIRED] === 'string' && retired[RETIRED].trim().length > 20, 'el retirado lleva su motivo');
  // cada conector trae su regla, con sus puntos
  const ado = read(path.join(ADO, 'rules.md'));
  for (const punto of [/un listado no es evidencia de lo que no muestra/i, /`runs list` está atrasado/, /la cola vive en el grupo de agentes/i,
    /cancelar la corrida no saca su trabajo de la cola/i, /un vigilante avisa; no re-encola/i, /una salida vacía puede ser un comando que falló/i,
    /`succeeded` habla de staging, no de prod/i]) assert.match(ado, punto);
  const gh = read(path.join(GH, 'rules.md'));
  for (const punto of [/The merge strategy for main is set by the merge queue/, /autoMergeRequest/, /`gh pr checks`/, /noreply/]) assert.match(gh, punto);
  // la línea neutra, y el presupuesto bajó en lo que pesaba el bloque
  assert.match(read(path.join(BLOCKS, 'platform-rules.md')), /las reglas de tu plataforma aparecen la primera vez que usás su CLI/i);
  const budget = JSON.parse(read(path.join(BLOCKS, 'budget.json')));
  assert.ok(!(RETIRED in budget.blocks), 'el bloque retirado no tiene techo');
  assert.ok(budget.total <= 18500 - 4500 + (budget.blocks['platform-rules'] || budget.default), `el total bajó (${budget.total})`);
  assert.ok(budget.total_codex <= 18700 - 4500 + (budget.blocks['platform-rules'] || budget.default), `el total de Codex bajó (${budget.total_codex})`);
  retiradoSeVaDeLoInstalado();
});

/** Una máquina que ya tiene el bloque escrito lo pierde, en el CLAUDE.md y en el AGENTS.md; lo de la persona queda. */
function retiradoSeVaDeLoInstalado() {
  const home = tmp('casa-sync-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const viejo = `<!-- TYCON_BLOCK:${RETIRED} START — generado por scripts/setup/sync-claude-md-blocks.sh del arnés -->\nREGLA VIEJA\n<!-- TYCON_BLOCK:${RETIRED} END -->`;
  const antes = '# mis notas\n\nuna regla escrita a mano\n';
  const despues = '\n# después\n\notra regla mía\n';
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claudeMd, `${antes}\n${viejo}\n${despues}`);
  const env = { HOME: home, PATH: process.env.PATH, TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8', TYCON_PROFILE: '0', TYCON_ADO_ORG: 'https://dev.azure.com/acme' };
  // con --check sólo avisa que sobra, y no toca el archivo
  const chk = spawnSync('bash', [SYNC, '--check'], { env, encoding: 'utf8' });
  assert.match(chk.stdout + chk.stderr, new RegExp(`${RETIRED}.*sobra`));
  assert.ok(read(claudeMd).includes('REGLA VIEJA'), '--check no escribe');
  // sin --check lo quita entre sus marcas, y lo de la persona queda como estaba
  const r = spawnSync('bash', [SYNC], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const md = read(claudeMd);
  assert.ok(!md.includes(`TYCON_BLOCK:${RETIRED}`) && !md.includes('REGLA VIEJA'), md);
  assert.ok(md.startsWith(antes), 'lo de antes, igual');
  assert.ok(md.includes(despues.trim()), 'lo de después, igual');
  // el AGENTS.md de Codex, lo mismo
  const A = require(path.join(ROOT, 'scripts', 'setup', 'agents-md-blocks.js'));
  const agents = path.join(home, 'AGENTS.md');
  fs.writeFileSync(agents, `${antes}\n${viejo}\n${despues}`);
  const facts = { integrations: { ado: true }, profile: 'full', response: null, packs: { blocks: [], active: [], why: null }, backup: false, quiet: true, home, env: { ...env }, target: agents };
  const c = A.sync({ ...facts, check: true });
  assert.ok(c.pending && c.lines.some((l) => l.includes(RETIRED) && /sobra/.test(l)), JSON.stringify(c.lines));
  A.sync(facts);
  const ag = read(agents);
  assert.ok(!ag.includes(`TYCON_BLOCK:${RETIRED}`) && !ag.includes('REGLA VIEJA'), ag);
  assert.ok(ag.startsWith(antes) && ag.includes(despues.trim()), 'lo de la persona, igual en AGENTS.md');
}

test('Rules_OnDemand_FirstCliUse_OncePerSession @story-8.85 @ac-35', () => {
  const o = org({ platform: { default: 'github', workItems: 'azure-devops' } });
  // la primera vez de cada plataforma, sus reglas; la segunda, nada; nunca frena
  const a1 = gancho(o, bash('ses-a', 'az pipelines runs list --pipeline-ids 12'));
  sinDecision(a1);
  assert.strictEqual(a1.json.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(dijoAdo(a1) && !dijoGh(a1), a1.raw);
  const a2 = gancho(o, bash('ses-a', 'az pipelines runs list --pipeline-ids 12'));
  sinDecision(a2);
  assert.ok(!dijoAdo(a2), 'la segunda vez, nada');
  const g1 = gancho(o, bash('ses-a', 'gh -R o/r pr checks 7'));
  sinDecision(g1);
  assert.ok(dijoGh(g1) && !dijoAdo(g1), g1.raw);
  // el reconocimiento: un tramo después de otro, opciones antes del subcomando; y lo que no es
  const b1 = gancho(o, bash('ses-b', 'cd x && az --only-show-errors repos pr list'));
  assert.ok(dijoAdo(b1), b1.raw);
  const c1 = gancho(o, bash('ses-c', 'gh repo view pr'));
  sinDecision(c1);
  assert.ok(!dijoGh(c1), 'gh repo view pr no es gh pr');
  assert.ok(!dijoAdo(gancho(o, bash('ses-c', 'echo az pipelines runs list'))), 'un echo no es el CLI');
  assert.ok(dijoAdo(gancho(o, bash('ses-c', 'TOKEN=x az boards query --org q'))), 'con una asignación delante, sí');
  // aunque el comando haya fallado (una salida vacía puede ser un comando que falló): Claude Code lo avisa con
  // PostToolUseFailure, que se contesta con su nombre
  const f1 = gancho(o, bash('ses-d', 'az pipelines runs list', { hook_event_name: 'PostToolUseFailure', error: 'Exit code 1\nERROR: Please run az login' }));
  sinDecision(f1);
  assert.ok(dijoAdo(f1), f1.raw);
  assert.strictEqual(f1.json.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.ok(!dijoAdo(gancho(o, bash('ses-d', 'az pipelines runs list'))), 'lo dicho tras el fallo cuenta para la sesión');
  // después de compactar, otra vez
  const compacto = gancho(o, { session_id: 'ses-a', hook_event_name: 'SessionStart', source: 'compact' });
  assert.strictEqual(compacto.status, 0);
  assert.ok(dijoAdo(gancho(o, bash('ses-a', 'az pipelines runs list'))), 'tras compactar, lo vuelve a decir');
  // sin session_id sale y no se recuerda
  assert.ok(dijoAdo(gancho(o, bash(undefined, 'az repos pr list'))));
  assert.ok(dijoAdo(gancho(o, bash(undefined, 'az repos pr list'))), 'sin sesión no hay memoria: sale otra vez');
  // un notices.json roto se dice en una línea y no frena
  fs.writeFileSync(path.join(o.ints, 'github', 'notices.json'), '{ roto');
  const roto = gancho(o, bash('ses-e', 'gh pr view 3'));
  sinDecision(roto);
  assert.match(roto.ctx, /avisos de extensiones: .*github.*notices\.json/);
  assert.ok(!dijoGh(roto));
  // el lector acepta after-command con sus comandos, y lo rechaza sin ellos
  const N = require(path.join(ROOT, 'scripts', 'lib', 'extension-notices.js'));
  const ext = tmp('ext-');
  fs.writeFileSync(path.join(ext, 'r.md'), 'regla\n');
  fs.writeFileSync(path.join(ext, 'notices.json'), JSON.stringify({ notices: [{ id: 'a', text: 'r.md', when: 'after-command', commands: ['az pipelines'] }, { id: 'b', text: 'r.md', when: 'after-command' }] }));
  const leido = N.readNotices(ext);
  assert.deepStrictEqual(leido.notices.map((n) => [n.id, n.when, n.commands]), [['a', 'after-command', ['az pipelines']]]);
  assert.match(leido.errors.join('\n'), /\(b\).*commands/);
  // el reconocimiento, directo
  assert.ok(N.matchesCommand('cd x && az --only-show-errors repos pr list', 'az repos'));
  assert.ok(N.matchesCommand('gh -R o/r pr checks 7', 'gh pr'));
  assert.ok(!N.matchesCommand('gh repo view pr', 'gh pr'));
  assert.ok(!N.matchesCommand('git log | grep "az repos"', 'az repos'));
  // lo que está entre comillas o en un heredoc es texto; `$(…)`, `timeout` y las palabras de la terminal no lo esconden
  assert.ok(!N.matchesCommand('ls && printf "%s" "az repos pr list"', 'az repos'));
  assert.ok(!N.matchesCommand('printf "usar\naz repos pr list"', 'az repos'), 'un renglón adentro de comillas no es un comando');
  assert.ok(!N.matchesCommand('cat <<EOF > notas.md\naz repos pr list\nEOF', 'az repos'), 'el cuerpo de un heredoc no es un comando');
  assert.ok(N.matchesCommand('PR=$(az repos pr list --status active)', 'az repos'));
  assert.ok(N.matchesCommand('timeout 30 az pipelines runs list', 'az pipelines'));
  assert.ok(N.matchesCommand('for i in 1 2; do az pipelines runs show --id $i; done', 'az pipelines'));
  assert.ok(N.matchesCommand('/usr/local/bin/gh pr checks 7', 'gh pr'));
  // el manifiesto roto del conector elegido no esconde sus reglas en silencio
  const om = org({ platform: { default: 'azure-devops' } });
  fs.writeFileSync(path.join(om.ints, 'azure-devops', 'integration.json'), '{ roto');
  const m1 = gancho(om, bash('ses-m', 'az pipelines runs list'));
  sinDecision(m1);
  assert.match(m1.ctx, /avisos de extensiones: integración azure-devops: su integration\.json no es válido/, m1.raw);
  // el de un conector que nadie eligió no se dice
  assert.ok(!/integración github/.test(gancho(om, bash('ses-m2', 'gh pr view 3')).ctx));
});

test('Rules_OtherPlatformNeverShown @story-8.85 @ac-35', () => {
  const chosen = (o) => {
    const r = spawnSync(process.execPath, [PLATFORM, 'chosen'], { env: o.env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  // sólo GitHub: el CLI de Azure DevOps no trae sus reglas
  const soloGh = org({ platform: { default: 'github' } });
  assert.deepStrictEqual(chosen(soloGh), { ok: true, value: ['github'] });
  const g = gancho(soloGh, bash('s1', 'az repos pr list'));
  sinDecision(g);
  assert.ok(!dijoAdo(g), g.raw);
  assert.ok(dijoGh(gancho(soloGh, bash('s1', 'gh pr view 3'))));
  // sólo Azure DevOps: el de GitHub no trae las suyas
  const soloAdo = org({ platform: { default: 'azure-devops' } });
  assert.deepStrictEqual(chosen(soloAdo), { ok: true, value: ['azure-devops'] });
  assert.ok(!dijoGh(gancho(soloAdo, bash('s2', 'gh pr view 3'))));
  // la organización de hoy: `ado.org` en la máquina, sin elección ni repos declarados, ve las de Azure DevOps
  const hoy = org({ adoOrg: 'https://dev.azure.com/acme' });
  assert.deepStrictEqual(chosen(hoy), { ok: true, value: ['azure-devops'] });
  assert.ok(dijoAdo(gancho(hoy, bash('s3', 'az pipelines runs list'))));
  // la plataforma de un repo declarado también cuenta (aunque el perfil no elija nada)
  const porRepo = org({ teamRepos: { version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' }, profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'azure', org: 'acme', project: 'Ops', repo: 'operaciones' } } });
  assert.deepStrictEqual(chosen(porRepo), { ok: true, value: ['azure-devops', 'github'] });
  // también un repo de historias o uno con su corredor de pruebas: cualquier repo que team-repos.json declara
  const azure = { version: 1, public: { platform: 'azure', org: 'acme', project: 'P', repo: 'arnes' }, profile: { platform: 'azure', org: 'acme', project: 'P', repo: 'perfil' }, operations: { platform: 'azure', org: 'acme', project: 'P', repo: 'operaciones' } };
  const gh = { platform: 'github', org: 'acme', repo: 'producto' };
  assert.deepStrictEqual(chosen(org({ teamRepos: { ...azure, story_index: { repos: [{ repo: gh, mode: 'generated' }] } } })), { ok: true, value: ['azure-devops', 'github'] });
  assert.deepStrictEqual(chosen(org({ teamRepos: { ...azure, stack: { test_runners: [{ name: 'x', detect: 'package.json', command: 'npm test', results: { format: 'junit', path: 'r.xml' }, repos: [{ repo: gh, args: 'unit' }] }] } } })), { ok: true, value: ['azure-devops', 'github'] });
  // nadie eligió nada: ninguna
  assert.deepStrictEqual(chosen(org({})), { ok: true, value: [] });
  // la configuración que no se lee es «no medido», y el gancho lo dice sin mostrar reglas de plataforma
  const roto = org({ perfilRoto: true });
  const c = chosen(roto);
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.reason, 'no_medido');
  const r = gancho(roto, bash('s4', 'az pipelines runs list'));
  sinDecision(r);
  assert.ok(!dijoAdo(r) && !dijoGh(r));
  assert.match(r.ctx, /avisos de extensiones: .*plataformas/);
  // los dos registran el gancho después de Bash
  const lista = JSON.parse(read(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'))).hooks;
  assert.ok(lista.some((h) => h.event === 'PostToolUse' && h.spec === '@tcg:extension-notices.js' && /(^|\|)Bash(\||$)/.test(h.matcher)), 'Claude Code: después de Bash');
  assert.ok(lista.some((h) => h.event === 'PostToolUseFailure' && h.spec === '@tcg:extension-notices.js' && /(^|\|)Bash(\||$)/.test(h.matcher)), 'Claude Code: después de un Bash que falló');
  const codex = JSON.parse(read(path.join(ROOT, 'adapters', 'codex', 'hooks.json')));
  const post = (codex.hooks || codex).PostToolUse || [];
  assert.ok(post.some((e) => e.matcher === 'Bash' && e.hooks.some((h) => /scripts\/hooks\/extension-notices\.js/.test(h.command))), 'Codex: después de Bash');
});
