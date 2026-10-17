'use strict';
/**
 * Story 7.5 — las reglas del repo que el revisor verifica.
 *
 * T1–T4: `lib/reviewer-rules.js` lee la sección `## Reglas para revisores` del CLAUDE.md del repo.
 * T5–T6: `buildAdvisorContext` la antepone al contexto de cada revisor (y al del validador).
 * T7:    `pipeline.js advisors` informa el estado en su JSON.
 * T8:    las definiciones de `agents/*.md` deciden `omitClaudeMd` (dos exceptuados, por nombre).
 *
 * T11:   nada de este archivo va a la HOME real (story 7.16 del arnés).
 *
 * Todo corre sobre repos de juguete en una carpeta temporal y con una HOME temporal para el proceso; el
 * contexto se escribe bajo un id de sesión propio del test y la HOME temporal se borra al final.
 */
const test = require('node:test');
const assert = require('node:assert');

// Story 8.7 (AC 8): un repo sin `packs:` activa los paquetes que diga `packs.default` (afuera, sin perfil: ninguno).
// Esta suite corre el pipeline con una HOME aislada y cuenta con «todos los instalados», como desde la 8.2: lo declara.
process.env.TYCON_PACKS_DEFAULT = (process.env.TYCON_PACKS_DEFAULT || '').trim() || 'all';   // recortada, como el cargador
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// Story 7.16 del arnés: HOME temporal para TODO el proceso, devuelta en `test.after`. Sin esto, T5–T7 escribían
// en advisor-context/ y advisor-runs/ de la HOME real, y los commits de repoDeJuguete corrían los ganchos
// GLOBALES de git del dev (el core.hooksPath de su ~/.gitconfig), que anotaban cada commit de juguete en su
// reviewer-rules.jsonl. Va ANTES de todo `require` de pipeline.js: fija rutas con os.homedir() al cargarse.
// El arnés y agent-skills se fijan con lo que resolvían con la HOME real, si no venían puestos (lo mismo que
// hace scripts/tests/lib/fake-home.sh del arnés para las suites bash).
const REAL_HOME = os.homedir();
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'reglas-rev-home-'));
const PREV_ENV = { HOME: process.env.HOME, TYCON_SKILLS_DIR: process.env.TYCON_SKILLS_DIR, TYCON_GUIDES_DIR: process.env.TYCON_GUIDES_DIR };
const REAL_SKILLS = path.join(REAL_HOME, '.claude', 'agent-skills', 'skills');
// el arnés de la máquina por su lugar y, si no, por el nombre viejo (story 8.19): los dos nombres, escritos (copia declarada)
const REAL_GUIDES = [path.join(REAL_HOME, '.claude', 'tycon-harness'), path.join(REAL_HOME, '.claude', 'tycon-claude-guides')].find((p) => fs.existsSync(p)) || '';
if (!process.env.TYCON_SKILLS_DIR && fs.existsSync(REAL_SKILLS)) process.env.TYCON_SKILLS_DIR = REAL_SKILLS;
if (!process.env.TYCON_GUIDES_DIR && REAL_GUIDES) process.env.TYCON_GUIDES_DIR = REAL_GUIDES;
process.env.HOME = FAKE_HOME;

const SCRIPTS = path.join(__dirname, '..');
const LIB = path.join(SCRIPTS, 'lib', 'reviewer-rules.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const AGENTS = path.join(SCRIPTS, '..', '..', '..', 'agents');
const SID = `test-reglas-revisores-${process.pid}`;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reglas-rev-'));
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });

const CLAUDE_CON_SECCION = [
  '# Proyecto X',
  '',
  'Intro del proyecto.',
  '',
  '## Otra',
  '',
  'Algo que no es de revisión.',
  '',
  '## Reglas para revisores',
  '',
  '- Nunca SQL concatenado.',
  '',
  '### Migraciones',
  '',
  '- Toda migración nace con su rollback.',
  '',
  '### Nombres',
  '',
  '- Tablas sin prefijo `OC_`.',
  '',
  '## Después',
  '',
  'Esto ya no es parte de la sección.',
  '',
].join('\n');

function repoDeJuguete({ claude, claudeDot, conCambio = true } = {}) {
  const repo = tmp();
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 1;\n');
  if (claude != null) fs.writeFileSync(path.join(repo, 'CLAUDE.md'), claude);
  if (claudeDot != null) {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'CLAUDE.md'), claudeDot);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  if (conCambio) fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 2; // TODO(Story-9.9-deferral) algo\n');
  return repo;
}

function cargarLib() {
  // ROJO PREVIO: la lib no existe todavía → el require falla y cada test lo dice.
  return require(LIB);
}

// ── T1–T4: la lectura de la sección ─────────────────────────────────────────────────────────

test('T1 Reglas_Presente_Recorta — del encabezado hasta antes del próximo ##, con los ### adentro', () => {
  const { reglasRevisores } = cargarLib();
  const repo = repoDeJuguete({ claude: CLAUDE_CON_SECCION, conCambio: false });
  const r = reglasRevisores(repo);
  assert.equal(r.estado, 'presente');
  assert.ok(r.texto.startsWith('## Reglas para revisores'), 'empieza en el encabezado');
  assert.ok(r.texto.includes('### Migraciones') && r.texto.includes('### Nombres'), 'conserva los ###');
  assert.ok(r.texto.includes('Tablas sin prefijo'), 'llega hasta el final de la sección');
  assert.ok(!r.texto.includes('## Después') && !r.texto.includes('Esto ya no es parte'), 'corta antes de ## Después');
  assert.ok(!r.texto.includes('Algo que no es de revisión'), 'no arrastra la sección anterior');
  assert.equal(r.bytes, Buffer.byteLength(r.texto, 'utf8'));
  assert.equal(r.fuente, 'CLAUDE.md');
  assert.equal(r.excede_techo, false);
});

test('T1b un # dentro de una cerca de código no corta la sección', () => {
  const { reglasRevisores } = cargarLib();
  const claude = '## Reglas para revisores\n\n- Regla uno.\n\n```bash\n# comentario de shell\n## tampoco corta\n```\n\n- Regla dos.\n\n# Otro título\n';
  const r = reglasRevisores(repoDeJuguete({ claude, conCambio: false }));
  assert.equal(r.estado, 'presente');
  assert.ok(r.texto.includes('Regla dos.'), 'la cerca no terminó la sección');
  assert.ok(!r.texto.includes('Otro título'));
});

test('T1c (5b) una cerca SIN CERRAR antes del encabezado no esconde la sección', () => {
  // Hallazgo del pase adversarial: el estado de cerca se arrastraba por todo el archivo y una cerca
  // abierta en una sección anterior dejaba la sección real «ausente» — el revisor sin reglas.
  const { reglasRevisores } = cargarLib();
  const claude = '# Proyecto\n\n## Ejemplos previos\n\n```bash\necho sin cerrar la cerca\n\n## Reglas para revisores\n\n- Nunca SQL concatenado.\n\n## Otra\n\nfin\n';
  const r = reglasRevisores(repoDeJuguete({ claude, conCambio: false }));
  assert.equal(r.estado, 'presente');
  assert.ok(r.texto.includes('Nunca SQL concatenado.'));
  assert.ok(!r.texto.includes('fin'), 'corta en ## Otra');
});

test('T1d un ejemplo del encabezado dentro de una cerca CERRADA no es la sección', () => {
  const { reglasRevisores } = cargarLib();
  const claude = '# Proyecto\n\nAsí se escribe:\n\n```markdown\n## Reglas para revisores\n\n- ejemplo\n```\n\n## Otra\n\nnada\n';
  assert.equal(reglasRevisores(repoDeJuguete({ claude, conCambio: false })).estado, 'ausente');
});

test('T2 Reglas_Estados_Ausente_Vacia_SinArchivo — nunca tira', () => {
  const { reglasRevisores } = cargarLib();
  assert.equal(reglasRevisores(repoDeJuguete({ conCambio: false })).estado, 'sin_claude_md');
  assert.equal(reglasRevisores(repoDeJuguete({ claude: '# X\n\n## Otra\n\nnada\n', conCambio: false })).estado, 'ausente');
  assert.equal(reglasRevisores(repoDeJuguete({ claude: '# X\n\n## Reglas para revisores\n\n   \n\n## Otra\n', conCambio: false })).estado, 'vacia');
  // un título parecido NO es la sección: el encabezado es exacto
  assert.equal(reglasRevisores(repoDeJuguete({ claude: '### Reglas para revisores\n\n- x\n', conCambio: false })).estado, 'ausente');

  const repo = repoDeJuguete({ claude: CLAUDE_CON_SECCION, conCambio: false });
  const f = path.join(repo, 'CLAUDE.md');
  fs.chmodSync(f, 0o000);
  try {
    let r;
    assert.doesNotThrow(() => { r = reglasRevisores(repo); });
    if (process.getuid && process.getuid() === 0) return; // root lee igual: el caso no se puede montar
    assert.equal(r.estado, 'no_medido');
    assert.ok(r.motivo && r.motivo.length > 0, 'trae motivo');
  } finally {
    fs.chmodSync(f, 0o644);
  }
  assert.doesNotThrow(() => reglasRevisores(path.join(os.tmpdir(), 'no-existe-reglas-rev-xyz')));
  assert.doesNotThrow(() => reglasRevisores(undefined));
});

test('T3 Reglas_DosArchivos_Concatena — CLAUDE.md y .claude/CLAUDE.md, en ese orden, cada uno con su fuente', () => {
  const { reglasRevisores } = cargarLib();
  const repo = repoDeJuguete({
    claude: '## Reglas para revisores\n\n- Regla de la raíz.\n',
    claudeDot: '# X\n\n## Reglas para revisores\n\n- Regla de .claude.\n\n## Otra\n',
    conCambio: false,
  });
  const r = reglasRevisores(repo);
  assert.equal(r.estado, 'presente');
  assert.deepEqual(r.fuentes, ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')]);
  assert.equal(r.fuente, `CLAUDE.md + ${path.join('.claude', 'CLAUDE.md')}`);
  const iRaiz = r.texto.indexOf('Regla de la raíz.');
  const iDot = r.texto.indexOf('Regla de .claude.');
  assert.ok(iRaiz >= 0 && iDot > iRaiz, 'las dos, raíz primero');
  assert.ok(r.texto.includes('(fuente: CLAUDE.md)') && r.texto.includes(`(fuente: ${path.join('.claude', 'CLAUDE.md')})`));
});

test('T4 Reglas_Techo_NoCorta — 5.000 bytes vuelven enteros con excede_techo', () => {
  const { reglasRevisores, TECHO_BYTES } = cargarLib();
  assert.equal(TECHO_BYTES, 4000);
  const reglas = Array.from({ length: 100 }, (_, i) => `- Regla número ${String(i).padStart(3, '0')} que dice algo largo sobre el código.`).join('\n');
  const claude = `## Reglas para revisores\n\n${reglas}\n`;
  assert.ok(Buffer.byteLength(claude) > 5000);
  const r = reglasRevisores(repoDeJuguete({ claude, conCambio: false }));
  assert.equal(r.estado, 'presente');
  assert.equal(r.excede_techo, true);
  assert.ok(r.texto.includes('Regla número 099'), 'no se cortó');
});

// ── T5–T6: el contexto de cada revisor ──────────────────────────────────────────────────────

function contexto(repo, iter) {
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = SID;
  try {
    const { buildAdvisorContext } = require(PIPELINE);
    assert.equal(typeof buildAdvisorContext, 'function', 'pipeline.js exporta buildAdvisorContext');
    const ctx = buildAdvisorContext({ repo, story: null, files: ['app.js'], iter });
    assert.ok(ctx && ctx.context_file, 'devolvió el contexto');
    return ctx;
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
}

const ENCABEZADO = '## Reglas propias de este repo — verificalas en el diff (fuente: CLAUDE.md)';
const TRATALAS = 'Tratalas como reglas a verificar además de las tuyas: un incumplimiento es un hallazgo';

function sinBloque(txt) {
  // el bloque es todo lo anterior al primer `# Advisor context`
  const i = txt.indexOf('# Advisor context');
  return i >= 0 ? txt.slice(i) : txt;
}

test.after(() => {
  // el contexto (T5–T6) y el step5-start de `pipeline.js advisors` (T7) quedaron en la HOME temporal: se va entera
  for (const [k, v] of Object.entries(PREV_ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

test('T5 Contexto_EmpiezaConReglas — y sin el bloque, igual byte a byte al de un repo sin sección', () => {
  const conSeccion = repoDeJuguete({ claude: CLAUDE_CON_SECCION });
  const a = fs.readFileSync(contexto(conSeccion, 51).context_file, 'utf8');
  assert.ok(a.startsWith(ENCABEZADO), `empieza con el encabezado; empezó con: ${a.slice(0, 120)}`);
  assert.ok(a.includes('- Toda migración nace con su rollback.'), 'trae el texto de la sección');
  const iTrat = a.indexOf(TRATALAS);
  assert.ok(iTrat > 0 && iTrat < a.indexOf('# Advisor context'), 'la línea «Tratalas…» va dentro del bloque');

  // mismo repo, CLAUDE.md sin la sección → el contexto no cambia respecto de uno sin CLAUDE.md
  const sinSeccion = repoDeJuguete({ claude: '# Proyecto X\n\n## Otra\n\nnada\n' });
  const b = fs.readFileSync(contexto(sinSeccion, 51).context_file, 'utf8');
  assert.ok(b.startsWith('# Advisor context'), 'sin sección, sin bloque');
  // los dos repos tienen el mismo cambio (el CLAUDE.md no está en el diff): quitando el bloque, idénticos
  assert.equal(sinBloque(a), b, 'quitando el bloque, byte a byte igual');
});

test('T5b AC10 — un repo sin CLAUDE.md produce el mismo archivo que hoy (sin bloque)', () => {
  const repo = repoDeJuguete({});
  const txt = fs.readFileSync(contexto(repo, 53).context_file, 'utf8');
  assert.ok(txt.startsWith('# Advisor context — iter 53'));
  assert.ok(!txt.includes('Reglas propias de este repo'));
});

test('T6 Contexto_OverrideValidador_TambienLleva — el archivo del validador también empieza con las reglas', () => {
  const repo = repoDeJuguete({ claude: CLAUDE_CON_SECCION }); // el cambio de app.js trae una marca de deuda
  const ctx = contexto(repo, 54);
  const sv = ctx.overrides && ctx.overrides['tycon-story-validator'];
  assert.ok(sv, 'hay override del validador');
  const txt = fs.readFileSync(sv, 'utf8');
  assert.ok(txt.startsWith(ENCABEZADO), `el override empieza con el encabezado; empezó con: ${txt.slice(0, 120)}`);
  assert.ok(txt.includes(TRATALAS));
  assert.ok(txt.includes('TODO(Story-9.9-deferral)'), 'el override conserva su hunk con deuda');
});

// ── T7: el estado en el JSON de `advisors` ──────────────────────────────────────────────────

function advisorsJson(repo) {
  const out = execFileSync('node', [PIPELINE, 'advisors', '--repo', repo, '--files', 'app.js'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: SID },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(out);
}

test('T7 Advisors_EstadoEnElJson — presente con bytes / ausente, y el set de revisores no cambia', () => {
  const con = advisorsJson(repoDeJuguete({ claude: CLAUDE_CON_SECCION }));
  const sin = advisorsJson(repoDeJuguete({ claude: '# Proyecto X\n\n## Otra\n\nnada\n' }));
  assert.ok(con.reglas_revisores, 'el JSON trae reglas_revisores');
  assert.equal(con.reglas_revisores.estado, 'presente');
  assert.ok(con.reglas_revisores.bytes > 0);
  assert.equal(sin.reglas_revisores.estado, 'ausente');
  assert.equal(sin.reglas_revisores.bytes, undefined, 'ausente no trae bytes');
  assert.deepEqual([...con.all].sort(), [...sin.all].sort(), 'el set de revisores es el mismo');
  const sinArchivo = advisorsJson(repoDeJuguete({}));
  assert.equal(sinArchivo.reglas_revisores.estado, 'sin_claude_md');
});

// ── T8: las definiciones de los revisores ───────────────────────────────────────────────────

const EXCEPTUADOS = ['tycon-dod-runtime-checker', 'tycon-retrospective-capturer'];
const { SKIP_PUBLIC, clientPackReviewers, absentReviewers } = require('./lib/public-copy.js');

function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const l of m[1].split('\n')) {
    const kv = l.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

test('T8 Agentes_OmitClaudeMd_Decidido — 24 del núcleo con el campo (más los del paquete de clientes), exactamente dos exceptuados por nombre, límites en los que tienen Bash', (t) => {
  // las definiciones de la raíz y las de la carpeta de agentes de cada paquete instalado (story 8.41: los revisores de un
  // stack viven en su paquete, que viaja con el perfil del equipo)
  const PACKS = path.join(AGENTS, '..', 'packs');
  const carpetas = [AGENTS, ...(fs.existsSync(PACKS) ? fs.readdirSync(PACKS) : []).map((p) => {
    try { const m = JSON.parse(fs.readFileSync(path.join(PACKS, p, 'pack.json'), 'utf8')); return m.agents ? path.join(PACKS, p, m.agents) : null; } catch (_) { return null; }
  }).filter(Boolean)];
  const defs = carpetas.flatMap((dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const md = fs.readFileSync(path.join(dir, f), 'utf8');
    return { file: f, md, fm: frontmatter(md) };
  }));
  // sin los paquetes del equipo (la copia pública) quedan las 13 del núcleo, 11 con el campo
  const DEL_NUCLEO = SKIP_PUBLIC ? 13 : 26;
  // Story 8.7 (tanda B): la copia pública sale sin las definiciones de los revisores del paquete de clientes. Los números
  // de este caso son los del núcleo (26 definiciones, 24 con el campo), que valen en los dos lados; en el repo del equipo
  // se les suman los revisores que declara el manifiesto de ese paquete, leídos de él y no escritos acá (antes era un 2
  // fijo, y sacar un revisor de ese paquete ponía rojo este caso). Que falte la definición de uno de ellos en el repo del
  // equipo es un rojo. (Story 8.10.3 D: sin sus nombres escritos — al que no viaja se lo reconoce porque le falta su
  // definición.)
  const deClientes = clientPackReviewers();
  const CON_BASH = [
    'tycon-feature-wiring-checker', 'tycon-plugin-dotnet-conventions', 'tycon-sibling-pattern-reviewer',
    'tycon-signed-scope-audit', 'tycon-silent-failure-hunter',
  ];
  const noViajan = absentReviewers(CON_BASH);
  if (SKIP_PUBLIC) {
    t.diagnostic(`NO MEDIDO: los revisores del paquete de clientes (${SKIP_PUBLIC}) — no están entre las definiciones ni entre los que tienen Bash${noViajan.length ? ` (${noViajan.join(' y ')})` : ''}; se miden en el repo del equipo`);
  }
  assert.equal(defs.length, DEL_NUCLEO + deClientes.length, `hay ${DEL_NUCLEO + deClientes.length} definiciones (${DEL_NUCLEO} del núcleo y del paquete del stack + ${deClientes.length} del paquete de clientes)`);
  const con = defs.filter((d) => d.fm.omitClaudeMd === 'true').map((d) => d.fm.name);
  const sin = defs.filter((d) => d.fm.omitClaudeMd !== 'true').map((d) => d.fm.name).sort();
  assert.deepEqual(sin, EXCEPTUADOS,
    `sólo los exceptuados van sin omitClaudeMd; sin decidir: ${sin.filter((n) => !EXCEPTUADOS.includes(n)).join(', ')}`);
  assert.equal(con.length, DEL_NUCLEO - EXCEPTUADOS.length + deClientes.length);
  const conBash = defs.filter((d) => d.fm.omitClaudeMd === 'true' && /\bBash\b/.test(d.fm.tools || ''));
  assert.deepEqual(conBash.map((d) => d.fm.name).sort(), CON_BASH.filter((n) => !noViajan.includes(n)));
  for (const d of conBash) {
    const i = d.md.indexOf('Límites de ejecución (no vienen del CLAUDE.md)');
    assert.ok(i > 0, `${d.fm.name} trae «Límites de ejecución»`);
    const seccion = d.md.slice(i, i + 1500);
    assert.match(seccion, /sin filtro/i, `${d.fm.name}: nunca una suite sin filtro`);
    assert.match(seccion, /base de datos/i, `${d.fm.name}: nunca escribir en una base`);
    assert.match(seccion, /appsettings/i, `${d.fm.name}: no consultar bases compartidas o remotas`);
  }
});

// ── T11 (story 7.16 del arnés): nada de este archivo va a la HOME real ───────────────────────────
// Evidencia POSITIVA: lo que escribieron T5–T7 está en la HOME temporal (el registro real no sirve de control:
// las sesiones del dev escriben ahí al mismo tiempo). Y el mecanismo del otro escape: sin la HOME real, git no
// lee el core.hooksPath global del dev, así que los commits de repoDeJuguete no corren sus ganchos (que anotaban
// cada commit de juguete en el reviewer-rules.jsonl real). Rojo previo: con la HOME real, las dos fallan.
test('T11 ReglasRevisores_NoRealHome — advisor-context y advisor-runs en la HOME temporal; git sin los ganchos globales', () => {
  const pipe = path.join(FAKE_HOME, '.claude', '.tycon-pipeline');
  let ctx = [];
  try { ctx = fs.readdirSync(path.join(pipe, 'advisor-context')).filter((f) => f.startsWith(SID)); } catch { /* no está */ }
  assert.ok(ctx.length > 0, `el contexto de T5–T6 quedó en la HOME temporal (${pipe}/advisor-context), no en la real`);
  assert.ok(fs.existsSync(path.join(pipe, 'advisor-runs', `${SID}.jsonl`)),
    'el step5-start de `pipeline.js advisors` (T7) quedó en la HOME temporal, no en la real');
  const repo = repoDeJuguete({});
  const r = spawnSync('git', ['-C', repo, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
  assert.equal((r.stdout || '').trim(), '', `git ve un core.hooksPath (${(r.stdout || '').trim()}): los commits de juguete corren ganchos del dev`);
});
