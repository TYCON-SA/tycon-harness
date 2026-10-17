'use strict';
// response-style-variants.test.js — cómo contesta Claude y la tabla de nombres, según la configuración (story 2.31).
//
// Lo que no se puede perder:
//   · sin `response` en el perfil, cada máquina escribe el bloque NEUTRO (corto, sin el estilo de TYCON) — T3;
//   · el perfil de TYCON (executive · es · 1300) deja el bloque de antes de la 2.31, salvo el título — T4;
//   · el medidor usa `response.max_chars`; sin valor, el tope del estilo — T5;
//   · un estilo fuera del vocabulario es configuración ROTA: el bloque que había queda y se avisa — T7;
//   · una fila de la tabla de nombres con su integración apagada no se escribe, en CLAUDE.md y en AGENTS.md; al prenderla
//     vuelve — T8; no saber no es «apagada»: la fila queda como estaba — T9;
//   · ningún título de bloque trae fechas ni historia, y el control del pre-commit lo frena — T10;
//   · todas las variantes del estilo caben en el techo de `response-style` — T14.
// Las tres implementaciones del sincronizador (bash/python, PowerShell y la de Codex) se prueban con la misma HOME.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BLOCKS = path.join(ROOT, 'claude-md-blocks');
const SYNC_SH = path.join(ROOT, 'scripts', 'setup', 'sync-claude-md-blocks.sh');
const SYNC_PS1 = path.join(ROOT, 'scripts', 'setup', 'sync-claude-md-blocks.ps1');
const AGENTS = path.join(ROOT, 'scripts', 'setup', 'agents-md-blocks.js');
const METER = path.join(ROOT, 'scripts', 'hooks', 'response-style-meter.js');
const CHECK = path.join(ROOT, 'scripts', 'ci', 'check-claude-md-blocks.js');
const BEFORE = path.join(__dirname, 'fixtures', 'response-style-before-2.31.md');
const STYLES = ['executive', 'detailed', 'neutral'];
const LANGS = ['es', 'en'];
const HAS_PWSH = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pwsh'], { encoding: 'utf8' }).status === 0;

const read = (f) => fs.readFileSync(f, 'utf8');
const startOf = (name) => `<!-- TYCON_BLOCK:${name} START`;
const endOf = (name) => `<!-- TYCON_BLOCK:${name} END -->`;
const between = (text, name) => { const i = text.indexOf(startOf(name)); const j = text.indexOf(endOf(name), i); return i === -1 || j === -1 ? null : text.slice(text.indexOf('\n', i) + 1, j).replace(/\n$/, ''); };
/** El cuerpo de un archivo de bloque, sin sus marcadores de condición (lo que el sincronizador copia). */
const bodyOf = (file) => read(file).replace(/^﻿/, '').split('\n').filter((l, i, a) => !(/^<!--\s*requires-(integration|profile):/.test(l) && a.slice(0, i).every((x) => /^<!--\s*requires-/.test(x)))).join('\n').replace(/^\n+|\n+$/g, '');
const withoutTitle = (text) => text.split('\n').filter((l) => !/^# [^=]/.test(l)).join('\n');
const fill = (text, max) => text.replace(/\{\{max_chars\}\}/g, String(max)).replace(/\{\{max_lines\}\}/g, String(Math.round(max / 100)));

/** Una HOME de juguete con su perfil del equipo (o sin él) y un entorno sin las variables del arnés de quien corre. */
function lab({ profile = {}, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-style-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const profileFile = path.join(home, 'team-profile.json');
  if (profile !== null) fs.writeFileSync(profileFile, `${JSON.stringify(profile, null, 2)}\n`);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TYCON_|CLAUDE_MD_PATH|CODEX_AGENTS_MD_PATH)/.test(k)));
  const e = Object.assign(clean, {
    HOME: home, USERPROFILE: home, TYCON_PROFILE: profile === null ? '0' : profileFile,
    CLAUDE_MD_PATH: path.join(home, '.claude', 'CLAUDE.md'), CODEX_AGENTS_MD_PATH: path.join(home, '.codex', 'AGENTS.md'),
    TYCON_CODEX: '0',
  }, env);
  return { home, env: e, claude: e.CLAUDE_MD_PATH, codex: e.CODEX_AGENTS_MD_PATH, profileFile };
}
const syncSh = (l) => spawnSync('bash', [SYNC_SH], { env: l.env, encoding: 'utf8' });
const syncPs1 = (l) => spawnSync('pwsh', ['-NoProfile', '-File', SYNC_PS1], { env: l.env, encoding: 'utf8' });
const syncCodex = (l) => spawnSync(process.execPath, [AGENTS], { env: l.env, encoding: 'utf8' });
const SYNCS = [['bash', syncSh], ...(HAS_PWSH ? [['pwsh', syncPs1]] : [])];

// Sin pwsh el sincronizador de Windows no se mide: se dice como NO MEDIDO (no es un verde), y en la CI es rojo —sus
// máquinas traen pwsh, y una que no lo trae dejaría pasar el .ps1 sin probarlo—.
test('PS1_SyncMeasured @story-2.31 @ac-19 — el sincronizador de Windows corre en estas pruebas', { skip: !HAS_PWSH && !process.env.CI ? 'NO MEDIDO: esta máquina no tiene pwsh; el .ps1 no se probó acá (no es un verde)' : false }, () => {
  assert.ok(HAS_PWSH, 'la CI tiene que traer pwsh: sin él, T3, T4, T7, T8 y T9 no prueban el .ps1');
});

const TYCON = { integrations: { clockify: true, engram: true, mailbox: true, codex: 'detect', nightly: true }, install: { profile: 'full' } };

test('T3 Sync_NoResponse_WritesNeutralShortBlock @story-2.31 @ac-3 —sin `response`, el bloque neutro en castellano, sin el estilo de TYCON', () => {
  const neutral = fill(bodyOf(path.join(BLOCKS, 'response-style', 'neutral.es.md')), 2000);
  assert.doesNotMatch(neutral, /EJECUTIVO|ejecutivo/, 'el neutro no trae el estilo de TYCON');
  for (const [name, run] of SYNCS) {
    const l = lab({ profile: { install: { profile: 'full' } } });
    const r = run(l);
    assert.strictEqual(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
    assert.strictEqual(between(read(l.claude), 'response-style'), neutral, `${name}: el bloque es neutral.es`);
    assert.ok(Buffer.byteLength(neutral) < 2500, 'el neutro es corto');
  }
});

test('T4 Sync_TyconProfile_SameBlockAsTodayExceptTitle @story-2.31 @ac-3 @ac-19 —executive/es/1300 deja el bloque de antes, salvo el título', () => {
  const before = withoutTitle(bodyOf(BEFORE));
  for (const [name, run] of SYNCS) {
    const l = lab({ profile: Object.assign({ response: { language: 'es', style: 'executive', max_chars: 1300 } }, TYCON) });
    const r = run(l);
    assert.strictEqual(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
    const got = between(read(l.claude), 'response-style');
    assert.strictEqual(withoutTitle(got), before, `${name}: el cuerpo es el de antes`);
    assert.match(got, /^# REGLA ESTILO DE RESPUESTA — ejecutivo primero$/m, `${name}: el título, sin fecha`);
  }
});

test('T5 Meter_UsesMaxCharsFromProfile @story-2.31 @ac-4 —el tope del medidor sale del perfil; sin valor, del estilo', () => {
  const prose = Array.from({ length: 15 }, (_, i) => `Oración ${i} con algunas palabras para sumar prosa medible en el turno.`).join(' ');
  assert.ok(prose.length > 800 && prose.length < 1300, `prosa de prueba: ${prose.length}`);
  const pending = (l) => path.join(l.home, '.claude', 'response-style', 'pending', 's1.json');
  const meter = (l) => spawnSync(process.execPath, [METER], { env: l.env, input: JSON.stringify({ session_id: 's1', last_assistant_message: prose }), encoding: 'utf8' });

  const conTope = lab({ profile: { response: { style: 'executive', max_chars: 800 } } });
  assert.strictEqual(meter(conTope).status, 0);
  assert.ok(fs.existsSync(pending(conTope)), 'con 800 de tope, el turno se pasa');
  assert.strictEqual(JSON.parse(read(pending(conTope))).maxProseChars, 800);

  const delEstilo = lab({ profile: { response: { style: 'executive' } } });
  meter(delEstilo);
  assert.ok(!fs.existsSync(pending(delEstilo)), 'executive sin max_chars: 1300, el turno no se pasa');

  const variable = lab({ profile: { response: { style: 'executive', max_chars: 800 } }, env: { TYCON_RESPONSE_MAX_PROSE_CHARS: '5000' } });
  meter(variable);
  assert.ok(!fs.existsSync(pending(variable)), 'la variable le gana al perfil');
});

test('T7 Sync_InvalidStyle_KeepsPreviousBlockAndReports @story-2.31 @ac-6 —un estilo inventado deja el bloque que había y lo dice', () => {
  for (const [name, run] of SYNCS) {
    const l = lab({ profile: { response: { style: 'fancy' } } });
    const old = `${startOf('response-style')} — viejo -->\nEL BLOQUE QUE HABÍA\n${endOf('response-style')}\n`;
    fs.writeFileSync(l.claude, `# mío\n\n${old}`);
    const r = run(l);
    assert.strictEqual(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
    assert.strictEqual(between(read(l.claude), 'response-style'), 'EL BLOQUE QUE HABÍA', `${name}: el bloque quedó igual`);
    assert.match(r.stdout, /response-style/, `${name}: lo avisa`);
  }
  const l = lab({ profile: { response: { style: 'fancy' } } });
  const v = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'), 'validate'], { env: l.env, encoding: 'utf8' });
  assert.strictEqual(v.status, 2, 'el lector la informa como configuración rota');
  assert.match(v.stderr, /response\.style|style/);
});

const ROWS = { telegram: /telegram/i, clockify: /clockify/i, engram: /engram/i, codegraph: /codegraph/i };
const rowsOf = (block) => (block || '').split('\n').filter((x) => x.startsWith('|'));

test('T8 ToolNames_IntegrationOff_RowAbsent_ClaudeAndCodex @story-2.31 @ac-7 —fila apagada fuera, en CLAUDE.md y AGENTS.md; al prender vuelve', () => {
  const off = { integrations: { clockify: false, engram: false, mailbox: false, codex: true, nightly: false }, install: { profile: 'full' } };
  const on = { integrations: { clockify: true, engram: true, mailbox: false, codex: true, nightly: false }, install: { profile: 'full' } };
  for (const [name, run] of [...SYNCS, ['codex', syncCodex]]) {
    const l = lab({ profile: off });
    const target = name === 'codex' ? l.codex : l.claude;
    assert.strictEqual(run(l).status, 0, name);
    const rows = rowsOf(between(read(target), 'tool-names'));
    assert.ok(rows.length > 3, `${name}: la tabla sigue con lo que no depende de nada`);
    for (const [k, re] of Object.entries(ROWS)) assert.ok(!rows.some((x) => re.test(x.split('|')[1])), `${name}: la fila de ${k} no está`);
    assert.doesNotMatch(read(target), /<!--\s*integration:/, `${name}: el marcador de fila no se copia`);
    // se prenden las cuatro: vuelven en la próxima sincronización
    fs.writeFileSync(l.profileFile, JSON.stringify(on));
    l.env.TYCON_TELEGRAM_CHAT_ID = '12345';
    l.env.TYCON_CODEGRAPH = '1';
    assert.strictEqual(run(l).status, 0, name);
    const back = rowsOf(between(read(target), 'tool-names'));
    for (const [k, re] of Object.entries(ROWS)) assert.ok(back.some((x) => re.test(x.split('|')[1])), `${name}: la fila de ${k} volvió`);
  }
});

test('T9 ToolNames_IntegrationUnknown_RowKept @story-2.31 @ac-8 —sin poder saber, cada fila queda como estaba', () => {
  for (const [name, run] of [...SYNCS, ['codex', syncCodex]]) {
    // primero con Telegram prendido y Clockify apagado; después el lector no contesta (perfil que no existe)
    const l = lab({ profile: { integrations: { clockify: false, engram: true, codex: true }, install: { profile: 'full' } }, env: { TYCON_TELEGRAM_CHAT_ID: '12345' } });
    const target = name === 'codex' ? l.codex : l.claude;
    assert.strictEqual(run(l).status, 0, name);
    const first = rowsOf(between(read(target), 'tool-names'));
    assert.ok(first.some((x) => /telegram/i.test(x.split('|')[1])) && !first.some((x) => /clockify/i.test(x.split('|')[1])), `${name}: punto de partida`);
    l.env.TYCON_PROFILE = path.join(l.home, 'no-existe.json');
    const r = run(l);
    assert.strictEqual(r.status, 0, name);
    const after = rowsOf(between(read(target), 'tool-names'));
    assert.ok(after.some((x) => /telegram/i.test(x.split('|')[1])), `${name}: la fila de Telegram quedó`);
    assert.ok(!after.some((x) => /clockify/i.test(x.split('|')[1])), `${name}: la de Clockify sigue sin estar`);
  }
});

/** Todos los archivos de bloque del árbol: los de arriba, las variantes de Codex y las del estilo. */
function blockFiles(dir = BLOCKS) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...blockFiles(f));
    else if (e.name.endsWith('.md')) out.push(f);
  }
  return out;
}

test('T10 BlockTitles_NoDatesNoHistory_GuardBlocks @story-2.31 @ac-9 —ningún título trae fecha ni historia, y el control lo frena', () => {
  for (const f of blockFiles()) {
    // el título: la línea que sigue a un `# ====` de la cabecera (las de `#` dentro de un bloque de código no lo son)
    const lines = read(f).split('\n');
    for (const line of lines.filter((x, i) => i > 0 && /^# =+\s*$/.test(lines[i - 1]) && /^# [^=]/.test(x))) {
      assert.doesNotMatch(line, /\d{4}-\d{2}-\d{2}|podada|promovida|cableado|actualizado/i, `${path.relative(ROOT, f)}: ${line}`);
    }
  }
  const real = spawnSync(process.execPath, [CHECK, '--repo', ROOT], { encoding: 'utf8' });
  assert.strictEqual(real.status, 0, `los bloques reales pasan: ${real.stdout}${real.stderr}`);
  // un repo de juguete con un título fechado: el control frena (exit 1) y nombra el bloque
  for (const title of ['# REGLA X (2026-07-25)', '# REGLA X — podada', '# REGLA Y (cableado el martes)']) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-title-'));
    fs.mkdirSync(path.join(repo, 'claude-md-blocks'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'scripts', 'ci'), { recursive: true });
    fs.copyFileSync(CHECK, path.join(repo, 'scripts', 'ci', 'check-claude-md-blocks.js'));
    fs.writeFileSync(path.join(repo, 'claude-md-blocks', 'budget.json'), JSON.stringify({ default: 2000, total: 9000, blocks: {} }));
    fs.writeFileSync(path.join(repo, 'claude-md-blocks', 'x.md'), `# ===\n${title}\n# ===\n\ncuerpo\n`);
    const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'ci', 'check-claude-md-blocks.js'), '--repo', repo], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1, `${title}: ${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /x.*t[ií]tulo/i);
  }
});

test('T14 Budget_EveryStyleVariantFitsCeiling @story-2.31 @ac-20 —las seis variantes caben en el techo de response-style', () => {
  const budget = JSON.parse(read(path.join(BLOCKS, 'budget.json')));
  const ceiling = budget.blocks['response-style'];
  assert.ok(Number.isInteger(ceiling) && ceiling > 0);
  for (const s of STYLES) {
    for (const lang of LANGS) {
      const f = path.join(BLOCKS, 'response-style', `${s}.${lang}.md`);
      assert.ok(fs.existsSync(f), `falta ${s}.${lang}`);
      // lo que viaja: con el tope más largo que acepta el lector
      const bytes = Buffer.byteLength(fill(read(f), 4000));
      assert.ok(bytes <= ceiling, `${s}.${lang}: ${bytes} > ${ceiling}`);
    }
  }
  // el contrato que leen el instalador, la desinstalación y sus pruebas: cada bloque es un `.md` en la raíz de la carpeta;
  // el de estilo declara que su texto sale de la carpeta de variantes del mismo nombre
  const stub = read(path.join(BLOCKS, 'response-style.md'));
  assert.match(stub, /^<!-- requires-profile: full -->\n<!-- variants: response -->\n/, 'response-style.md declara sus variantes');
});

// ── pase adversarial: las tres implementaciones dan lo mismo en los bordes ───────────────────────────────────────
/** Un árbol de juguete: los tres sincronizadores y el lector de este repo, con los bloques que se pidan. */
function arbol(bloques) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-arbol-'));
  fs.mkdirSync(path.join(t, 'scripts', 'setup'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(t, 'scripts', 'lib'), { recursive: true });
  for (const f of ['sync-claude-md-blocks.sh', 'sync-claude-md-blocks.ps1', 'agents-md-blocks.js']) fs.copyFileSync(path.join(ROOT, 'scripts', 'setup', f), path.join(t, 'scripts', 'setup', f));
  // el lector del perfil de instalación que usa el escritor de Codex (sin él, todo cuenta como «completo»)
  fs.mkdirSync(path.join(t, 'scripts', 'setup', 'harness'), { recursive: true });
  for (const f of ['profile.js', 'plan.js']) fs.copyFileSync(path.join(ROOT, 'scripts', 'setup', 'harness', f), path.join(t, 'scripts', 'setup', 'harness', f));
  for (const [rel, txt] of Object.entries(bloques)) { const f = path.join(t, 'claude-md-blocks', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); }
  return t;
}
const enArbol = (t) => [
  ['bash', (l) => spawnSync('bash', [path.join(t, 'scripts', 'setup', 'sync-claude-md-blocks.sh')], { env: l.env, encoding: 'utf8' }), (l) => l.claude],
  ...(HAS_PWSH ? [['pwsh', (l) => spawnSync('pwsh', ['-NoProfile', '-File', path.join(t, 'scripts', 'setup', 'sync-claude-md-blocks.ps1')], { env: l.env, encoding: 'utf8' }), (l) => l.claude]] : []),
  ['codex', (l) => spawnSync(process.execPath, [path.join(t, 'scripts', 'setup', 'agents-md-blocks.js')], { env: l.env, encoding: 'utf8' }), (l) => l.codex],
];
const nombresEnOrden = (texto) => [...texto.matchAll(/<!-- TYCON_BLOCK:([^\s]+) START/g)].map((m) => m[1]);

test('A1 Sync_SameOrderAndTieRule_ThreeImplementations @story-2.31 @ac-3 (pase adversarial) — mismo orden por código de carácter; una carpeta sin la marca en su archivo no es un bloque', () => {
  const t = arbol({ 'Zeta.md': '# Z\nz\n', 'alfa.md': '# A\na\n', 'beta-x.md': '# B1\nb1\n', 'beta_x.md': '# B2\nb2\n', 'dup.md': '# DUP ARCHIVO\narchivo\n', 'dup/neutral.es.md': '# DUP CARPETA\ncarpeta\n', 'suelta/neutral.es.md': '# SUELTA\nno es un bloque\n' });
  const vistos = [];
  for (const [name, run, target] of enArbol(t)) {
    const l = lab({ profile: {} });
    assert.strictEqual(run(l).status, 0, name);
    const txt = read(target(l));
    vistos.push([name, nombresEnOrden(txt).join(',')]);
    assert.match(between(txt, 'dup'), /DUP ARCHIVO/, `${name}: sin la marca, el archivo es el texto`);
    assert.strictEqual(txt.split('TYCON_BLOCK:dup START').length - 1, 1, `${name}: un solo bloque dup`);
    assert.doesNotMatch(txt, /TYCON_BLOCK:suelta/, `${name}: una carpeta sin su archivo no es un bloque`);
  }
  assert.deepStrictEqual(vistos.map((v) => v[1]), vistos.map(() => 'Zeta,alfa,beta-x,beta_x,dup'), JSON.stringify(vistos));
});

test('A2 Rows_UnknownState_CaseSensitive_AndCRLF @story-2.31 @ac-8 (pase adversarial) — sin saber, la fila queda sólo si estaba igual (mayúsculas incluidas), también con CRLF', () => {
  const t = arbol({ 'tabla.md': '# T\n| A | B |\n|---|---|\n| Telegram — avisar | x | <!-- integration: telegram -->\n| siempre | y |\n' });
  for (const [name, run, target] of enArbol(t)) {
    const l = lab({ profile: {} });
    l.env.TYCON_PROFILE = path.join(l.home, 'no-existe.json');   // el lector no contesta: «no se pudo saber»
    const marca = name === 'codex' ? '<!-- TYCON_BLOCK:tabla START — viejo -->' : '<!-- TYCON_BLOCK:tabla START — viejo -->';
    fs.mkdirSync(path.dirname(target(l)), { recursive: true });
    // la fila escrita con otras mayúsculas no es la misma fila; y el archivo viene con fines de línea de Windows
    fs.writeFileSync(target(l), [marca, '# T', '| A | B |', '|---|---|', '| TELEGRAM — AVISAR | x |', '| siempre | y |', '<!-- TYCON_BLOCK:tabla END -->', ''].join('\r\n'));
    assert.strictEqual(run(l).status, 0, name);
    const filas = rowsOf(between(read(target(l)).replace(/\r\n/g, '\n'), 'tabla'));
    assert.ok(!filas.some((x) => /telegram/i.test(x)), `${name}: con otras mayúsculas no cuenta como «estaba»: ${filas}`);
    // y la misma fila exacta, con CRLF, sí queda
    fs.writeFileSync(target(l), [marca, '# T', '| A | B |', '|---|---|', '| Telegram — avisar | x |', '| siempre | y |', '<!-- TYCON_BLOCK:tabla END -->', ''].join('\r\n'));
    assert.strictEqual(run(l).status, 0, name);
    assert.ok(rowsOf(between(read(target(l)).replace(/\r\n/g, '\n'), 'tabla')).includes('| Telegram — avisar | x |'), `${name}: la fila exacta queda aunque el archivo venga con CRLF`);
  }
});

test('A3 Check_HistorySignalsInVariants_TitlesOnlyInShippedBlocks @story-2.31 @ac-9 (pase adversarial) — las señales de historia miran las variantes; un .md anidado que no viaja no frena por su título', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-var-'));
  fs.mkdirSync(path.join(repo, 'claude-md-blocks', 'response-style'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'claude-md-blocks', 'names'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts', 'ci'), { recursive: true });
  fs.copyFileSync(CHECK, path.join(repo, 'scripts', 'ci', 'check-claude-md-blocks.js'));
  fs.writeFileSync(path.join(repo, 'claude-md-blocks', 'budget.json'), JSON.stringify({ default: 9000, total: 99000, blocks: {} }));
  fs.writeFileSync(path.join(repo, 'claude-md-blocks', 'response-style', 'neutral.es.md'), '# ===\n# REGLA\n# ===\n\ncuerpo\n');
  fs.writeFileSync(path.join(repo, 'claude-md-blocks', 'names', 'README.md'), '# ===\n# Notas (2026-07-25)\n# ===\n');
  const fecha = '2026-10-16T12:00:00Z';
  const g = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=b@b', '-c', 'user.name=b', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  const correr = () => spawnSync(process.execPath, [path.join(repo, 'scripts', 'ci', 'check-claude-md-blocks.js'), '--repo', repo, '--staged'], { encoding: 'utf8' });
  let r = correr();
  assert.strictEqual(r.status, 0, `un README anidado no viaja: su título no frena\n${r.stdout}${r.stderr}`);
  fs.appendFileSync(path.join(repo, 'claude-md-blocks', 'response-style', 'neutral.es.md'), '\nCaso disparador (un repo, 2026-07-29): pasó algo.\n');
  g('add', '-A');
  r = correr();
  assert.strictEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /caso disparador/, 'la señal de historia también se mira en las variantes');
});

test('A5 Meter_BrokenConfig_WarnsAndUses1300 @story-2.31 @ac-4 @ac-6 (vuelta 2) — con la configuración rota, el medidor avisa y mide con el tope de siempre', () => {
  const prose = Array.from({ length: 15 }, (_, i) => `Oración ${i} con algunas palabras para sumar prosa medible en el turno.`).join(' ');
  const l = lab({ profile: { response: { style: 'fancy', max_chars: 800 } } });
  const m = spawnSync(process.execPath, [METER], { env: l.env, input: JSON.stringify({ session_id: 's1', last_assistant_message: prose }), encoding: 'utf8' });
  assert.strictEqual(m.status, 0);
  assert.match(m.stderr, /configuración del arnés está rota.*1300/);
  assert.ok(!fs.existsSync(path.join(l.home, '.claude', 'response-style', 'pending', 's1.json')), `${prose.length} caracteres no pasan de 1300: el 800 roto no se usó`);
});

test('A6 Sync_UnreadableVariantsFolder_KeepsBlockAndSays @story-2.31 @ac-6 (vuelta 2) — una carpeta de variantes ilegible: el bloque queda y se avisa, en las tres', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'chmod no quita la lectura acá' : false }, () => {
  const t = arbol({ 'otro.md': '# O\no\n', 'estilo.md': '<!-- variants: response -->\n', 'estilo/neutral.es.md': '# E\ne\n' });
  const carpeta = path.join(t, 'claude-md-blocks', 'estilo');
  try {
    for (const [name, run, target] of enArbol(t)) {
      const l = lab({ profile: {} });
      fs.mkdirSync(path.dirname(target(l)), { recursive: true });
      fs.writeFileSync(target(l), '<!-- TYCON_BLOCK:estilo START — viejo -->\nEL QUE HABÍA\n<!-- TYCON_BLOCK:estilo END -->\n');
      fs.chmodSync(carpeta, 0o000);
      const r = run(l);
      fs.chmodSync(carpeta, 0o755);
      assert.strictEqual(r.status, 0, name);
      assert.strictEqual(between(read(target(l)), 'estilo'), 'EL QUE HABÍA', `${name}: el bloque quedó igual`);
      assert.match(`${r.stdout}${r.stderr}`, /'estilo'.*no pude leer su carpeta de variantes.*queda como estaba/, `${name}: lo dice`);
    }
  } finally { fs.chmodSync(carpeta, 0o755); }
});

test('A7 VariantsBlock_ConditionsFirst_OffRemoves_UnknownKeeps @story-2.31 @ac-3 @ac-6 (vuelta 5) — el bloque con variantes mira su perfil antes de elegir texto, en las tres', () => {
  const t = arbol({ 'estilo.md': '<!-- requires-profile: full -->\n<!-- variants: response -->\n', 'estilo/neutral.es.md': '<!-- requires-profile: full -->\n# E\ntexto {{max_chars}}\n' });
  for (const [name, run, target] of enArbol(t)) {
    // perfil full: se escribe la variante
    const l = lab({ profile: { install: { profile: 'full' } } });
    assert.strictEqual(run(l).status, 0, name);
    assert.strictEqual(between(read(target(l)), 'estilo'), '# E\ntexto 2000', `${name}: con full, la variante`);
    // sin poder saber el perfil: queda como estaba, con el aviso de siempre (el del perfil), y nunca el texto de la marca
    fs.writeFileSync(target(l), read(target(l)).replace('texto 2000', 'EL QUE HABÍA'));
    l.env.TYCON_PROFILE = path.join(l.home, 'no-existe.json');
    const r = run(l);
    assert.strictEqual(between(read(target(l)), 'estilo'), '# E\nEL QUE HABÍA', `${name}: sin saber, queda como estaba`);
    // el motivo depende de qué no se pudo saber (el escritor de Codex lee el perfil por su propio camino): siempre se dice
    assert.match(`${r.stdout}${r.stderr}`, /'estilo'(?: requiere el perfil «full» y no pude saber|: no pude saber cómo tiene que contestar)/, `${name}: lo dice`);
    assert.doesNotMatch(read(target(l)), /variants: response/, `${name}: la marca no se copia`);
    // perfil minimal: el bloque se va
    fs.writeFileSync(l.profileFile, JSON.stringify({ install: { profile: 'minimal' } }));
    l.env.TYCON_PROFILE = l.profileFile;
    assert.strictEqual(run(l).status, 0, name);
    assert.strictEqual(between(read(target(l)), 'estilo'), null, `${name}: con minimal, el bloque se va`);
  }
});

test('A8 Check_VariantsWeightBothSides_LooseFolderIgnored @story-2.31 @ac-20 (vuelta 5) — el control pesa la variante más pesada en los dos lados y no mide una carpeta suelta', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-peso-'));
  fs.mkdirSync(path.join(repo, 'claude-md-blocks', 'estilo'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'claude-md-blocks', 'suelta'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts', 'ci'), { recursive: true });
  fs.copyFileSync(CHECK, path.join(repo, 'scripts', 'ci', 'check-claude-md-blocks.js'));
  fs.writeFileSync(path.join(repo, 'claude-md-blocks', 'budget.json'), JSON.stringify({ default: 3000, total: 9000, total_codex: 9000, blocks: {} }));
  fs.writeFileSync(path.join(repo, 'claude-md-blocks', 'estilo.md'), '<!-- variants: response -->\n');
  fs.writeFileSync(path.join(repo, 'claude-md-blocks', 'estilo', 'neutral.es.md'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(repo, 'claude-md-blocks', 'suelta', 'neutral.es.md'), 'y'.repeat(5000));   // pasaría el techo
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'ci', 'check-claude-md-blocks.js'), '--repo', repo, '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `la carpeta suelta no se mide: ${r.stdout}${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert.ok(!j.filas.some((f) => /suelta/.test(f.ruta)), 'sin filas de la carpeta suelta');
  assert.ok(j.sumaCodex >= 1000 && j.suma >= 1000, `la variante pesa en los dos lados: ${j.suma} / ${j.sumaCodex}`);
});

test('A4 Meter_OptOut_DoesNotReadConfig_NoticeFollowsTheStyle @story-2.31 @ac-4 (pase adversarial) — apagado no lee nada; el aviso no da por hecho el estilo de TYCON', () => {
  const rota = lab({ profile: { response: { style: 'fancy' } }, env: { TYCON_RESPONSE_METER: '0' } });
  const m = spawnSync(process.execPath, [METER], { env: rota.env, input: JSON.stringify({ session_id: 's1', last_assistant_message: 'hola' }), encoding: 'utf8' });
  assert.strictEqual(m.status, 0);
  assert.strictEqual(m.stderr, '', 'el medidor apagado no lee la configuración ni avisa');
  // el aviso del turno siguiente nombra el tope medido y no dice «castellano llano» ni «~10 líneas» (eso es del estilo de TYCON)
  const l = lab({ profile: {} });
  const dir = path.join(l.home, '.claude', 'response-style', 'pending');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's1.json'), JSON.stringify({ reasons: ['3000 caracteres'], maxProseChars: 2000, maxHeaders: 1, maxSentenceWords: 35 }));
  const n = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', 'response-style-notice.js')], { env: l.env, input: JSON.stringify({ session_id: 's1' }), encoding: 'utf8' });
  assert.strictEqual(n.status, 0);
  assert.match(n.stdout, /2000 caracteres de prosa/);
  assert.doesNotMatch(n.stdout, /castellano llano|~10 líneas/);
});
