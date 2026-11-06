'use strict';
// response-language.test.js — el asistente contesta en el idioma de la persona (`response.language: auto`).
//
// Lo que no se puede perder:
//   · la copia del lector del freno de producción acepta `auto`: no lee como rota una configuración con `auto` — T2;
//   · con `auto`, CLAUDE.md y AGENTS.md reciben el bloque del estilo en castellano con la regla de idioma al final. El
//     texto sale de `<estilo>.auto.md`, que es `<estilo>.es.md` byte a byte más la regla; los selectores de Windows
//     arman el mismo nombre de archivo — T4;
//   · con `es` o `en` declarados, y con el perfil de TYCON, el bloque es el mismo que antes del cambio, byte a byte — T5;
//   · `auto ` con espacio o `AUTO` son configuración rota, como cualquier valor fuera de la lista — T7.
// Las referencias de T5 (fixtures/response-language/) las escribió el sincronizador de Mac antes del cambio.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VARIANTS = path.join(ROOT, 'claude-md-blocks', 'response-style');
const BUDGET = path.join(ROOT, 'claude-md-blocks', 'budget.json');
const LIB = path.join(ROOT, 'scripts', 'lib', 'tycon-config.js');
const GUARD_LIB = path.join(ROOT, 'scripts', 'production', 'guard-libs', 'lib', 'tycon-config.js');
const SYNC_SH = path.join(ROOT, 'scripts', 'setup', 'sync-claude-md-blocks.sh');
const SYNC_PS1 = path.join(ROOT, 'scripts', 'setup', 'sync-claude-md-blocks.ps1');
const INSTALL_PS1 = path.join(ROOT, 'scripts', 'install-tycon-hooks.ps1');
const AGENTS = path.join(ROOT, 'scripts', 'setup', 'agents-md-blocks.js');
const BEFORE = path.join(__dirname, 'fixtures', 'response-language');
const STYLES = ['executive', 'detailed', 'neutral'];
const HAS_PWSH = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pwsh'], { encoding: 'utf8' }).status === 0;
const TYCON = { integrations: { clockify: true, engram: true, mailbox: true, codex: 'detect', nightly: true }, install: { profile: 'full' } };

const read = (f) => fs.readFileSync(f, 'utf8');
const startOf = (name) => `<!-- TYCON_BLOCK:${name} START`;
const endOf = (name) => `<!-- TYCON_BLOCK:${name} END -->`;
const between = (text, name) => { const i = text.indexOf(startOf(name)); const j = text.indexOf(endOf(name), i); return i === -1 || j === -1 ? null : text.slice(text.indexOf('\n', i) + 1, j).replace(/\n$/, ''); };

/** Una HOME de juguete con su perfil del equipo y un entorno sin las variables del arnés de quien corre. */
function lab(profile) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-lang-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const profileFile = path.join(home, 'team-profile.json');
  fs.writeFileSync(profileFile, `${JSON.stringify(profile, null, 2)}\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TYCON_|CLAUDE_MD_PATH|CODEX_AGENTS_MD_PATH)/.test(k)));
  Object.assign(env, {
    HOME: home, USERPROFILE: home, TYCON_PROFILE: profileFile,
    CLAUDE_MD_PATH: path.join(home, '.claude', 'CLAUDE.md'), CODEX_AGENTS_MD_PATH: path.join(home, '.codex', 'AGENTS.md'), TYCON_CODEX: '0',
  });
  return { home, env, claude: env.CLAUDE_MD_PATH, codex: env.CODEX_AGENTS_MD_PATH };
}
const SYNCS = [
  ['bash', (l) => spawnSync('bash', [SYNC_SH], { env: l.env, encoding: 'utf8' }), (l) => l.claude],
  ...(HAS_PWSH ? [['pwsh', (l) => spawnSync('pwsh', ['-NoProfile', '-File', SYNC_PS1], { env: l.env, encoding: 'utf8' }), (l) => l.claude]] : []),
  ['codex', (l) => spawnSync(process.execPath, [AGENTS], { env: l.env, encoding: 'utf8' }), (l) => l.codex],
];
/** El bloque de estilo que deja cada sincronizador con este perfil. */
function blockFrom([name, run, target], profile) {
  const l = lab(name === 'codex' ? Object.assign({}, profile, { integrations: Object.assign({}, profile.integrations, { codex: true }) }) : profile);
  const r = run(l);
  assert.strictEqual(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
  const got = between(read(target(l)), 'response-style');
  fs.rmSync(l.home, { recursive: true, force: true });
  return got;
}
/** La regla de idioma: lo que `<estilo>.auto.md` agrega a `<estilo>.es.md`. */
function ruleOf(style) {
  const es = read(path.join(VARIANTS, `${style}.es.md`));
  const auto = read(path.join(VARIANTS, `${style}.auto.md`));
  assert.ok(auto.startsWith(es), `${style}.auto.md no empieza por ${style}.es.md byte a byte: copiá ${style}.es.md a ${style}.auto.md y agregale al final la regla de idioma (la misma de los otros .auto.md)`);
  return auto.slice(es.length).replace(/^\n+|\n+$/g, '');
}

test('T2 LectorDelFreno_AceptaAuto @story-8.149 @ac-1 — la copia del lector del freno no lee como rota una configuración con auto', () => {
  const G = require(GUARD_LIB);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-lang-guard-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const arnes = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-lang-guard-arnes-'));
  fs.writeFileSync(path.join(arnes, G.NOMBRE_PERFIL), JSON.stringify({ response: { language: 'auto' } }));
  const c = G.cargar({ home, arnes, env: {} });
  assert.deepStrictEqual(c.errores.filter((e) => /response/.test(e.clave)), [], 'auto no es configuración rota para el freno');
  assert.strictEqual(G.respuesta(c).language, 'auto');
  // y la misma lista que el lector compartido
  assert.strictEqual(G.VOCABULARIO.response.language, require(LIB).VOCABULARIO.response.language);
});

test('T4 Auto_EscribeLaReglaDeIdioma @story-8.149 @ac-3 — con auto, el bloque en castellano con la regla de idioma, en CLAUDE.md y AGENTS.md', () => {
  // cada .auto.md es su .es.md byte a byte más la misma regla, corta
  const rules = STYLES.map(ruleOf);
  assert.strictEqual(new Set(rules).size, 1, 'la regla es la misma en los tres .auto.md');
  const rule = rules[0];
  assert.ok(Buffer.byteLength(rule) <= 200, `la regla pesa ${Buffer.byteLength(rule)} bytes: a lo sumo 200`);
  assert.match(rule, /idioma en que te escribe la persona/);
  assert.match(rule, /si no se sabe, en castellano/);
  // los dos selectores de Windows arman <estilo>.<idioma>.md, así que con `auto` abren el .auto.md
  assert.match(read(SYNC_PS1), /"\$\(\$resp\.Data\.style\)\.\$\(\$resp\.Data\.language\)\.md"/);
  assert.match(read(INSTALL_PS1), /"\$\(\$resp\.style\)\.\$\(\$resp\.language\)\.md"/);
  // lo que escriben los sincronizadores: el bloque de hoy en castellano y la regla al final
  for (const sync of SYNCS) {
    for (const style of STYLES) {
      const got = blockFrom(sync, { install: { profile: 'full' }, response: { language: 'auto', style } });
      assert.strictEqual(got, `${read(path.join(BEFORE, `${style}.es.md`)).replace(/\n+$/, '')}\n\n${rule}`, `${sync[0]}/${style}: bloque castellano + regla`);
    }
  }
  // las nueve variantes caben en el techo de response-style
  const ceiling = JSON.parse(read(BUDGET)).blocks['response-style'];
  for (const style of STYLES) {
    for (const lang of ['es', 'en', 'auto']) {
      const bytes = Buffer.byteLength(read(path.join(VARIANTS, `${style}.${lang}.md`)).replace(/\{\{max_chars\}\}/g, '4000'));
      assert.ok(bytes <= ceiling, `${style}.${lang}: ${bytes} > ${ceiling}`);
    }
  }
  // y el control del techo del pre-commit las mide a las tres nuevas (no sólo las de dos letras)
  const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'check-claude-md-blocks.js')], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(check.status, 0, `${check.stdout}${check.stderr}`);
  for (const style of STYLES) assert.match(`${check.stdout}${check.stderr}`, new RegExp(`variante ${style}\\.auto\\b`), `el control mide ${style}.auto`);
});

test('T5 Declarado_MismoBloqueQueHoy @story-8.149 @ac-4 @ac-10 — con es o en declarados, y con el perfil de TYCON, el bloque de antes byte a byte', () => {
  for (const sync of SYNCS) {
    for (const style of STYLES) {
      for (const language of ['es', 'en']) {
        const got = blockFrom(sync, { install: { profile: 'full' }, response: { language, style } });
        assert.strictEqual(`${got}\n`, read(path.join(BEFORE, `${style}.${language}.md`)), `${sync[0]}/${style}/${language}: igual que antes`);
      }
    }
    const tycon = blockFrom(sync, Object.assign({ response: { language: 'es', style: 'executive', max_chars: 1300 } }, TYCON));
    assert.strictEqual(`${tycon}\n`, read(path.join(BEFORE, 'tycon.md')), `${sync[0]}: el perfil de TYCON, igual que antes`);
  }
  // el perfil de TYCON instalado en esta máquina declara `es` (Task 4); sin perfil instalado no se mide acá
  const installed = path.join(os.homedir(), '.tycon', 'harness', 'team-profile.json');
  if (fs.existsSync(installed)) {
    const p = JSON.parse(read(installed));
    if (p.response) assert.strictEqual(p.response.language, 'es', 'el perfil de TYCON declara es');
  }
});

test('T7 Auto_ValorFueraDeLista_Rota @story-8.149 @ac-1 — auto en mayúsculas es configuración rota; con espacios se lee como auto, igual que es', () => {
  const cargarCon = (C, v) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-lang-rota-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const arnes = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-lang-rota-arnes-'));
    fs.writeFileSync(path.join(arnes, C.NOMBRE_PERFIL), JSON.stringify({ response: { language: v } }));
    return C.cargar({ home, arnes, env: {} });
  };
  for (const file of [LIB, GUARD_LIB]) {
    const C = require(file);
    for (const v of ['AUTO', 'Auto', 'automatico']) {
      assert.ok(cargarCon(C, v).errores.some((e) => /response\.language/.test(e.clave)), `${path.relative(ROOT, file)}: ${JSON.stringify(v)} rota`);
    }
    // el lector recorta los espacios de cualquier opción (`es ` ya se lee como `es`): `auto` sigue la misma regla
    for (const v of ['auto ', ' auto']) {
      const c = cargarCon(C, v);
      assert.deepStrictEqual([c.errores.filter((e) => /response/.test(e.clave)).length, C.respuesta(c).language], [0, 'auto'], `${path.relative(ROOT, file)}: ${JSON.stringify(v)} es auto`);
    }
    assert.strictEqual(C.respuesta(cargarCon(C, 'es ')).language, 'es', 'la misma regla que para es');
    // por variable, igual
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-lang-env-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    assert.ok(C.cargar({ home, arnes: fs.mkdtempSync(path.join(os.tmpdir(), 'resp-lang-env-arnes-')), env: { TYCON_RESPONSE_LANGUAGE: 'AUTO' } }).errores.some((e) => e.clave === 'TYCON_RESPONSE_LANGUAGE'), `${path.relative(ROOT, file)}: variable AUTO rota`);
  }
});
