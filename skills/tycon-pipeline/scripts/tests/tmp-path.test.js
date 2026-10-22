'use strict';

/**
 * tmp-path.test.js — la ruta del archivo de configuración de las pruebas de punta a punta (T71).
 *
 * EL AGUJERO QUE CIERRA. Escribir la configuración de E2E con una redirección de bash a `/tmp/e2ecfg.json` y leerla con
 * `node -e 'require("/tmp/e2ecfg.json")'` anda en Mac y Linux (es el mismo archivo), pero no en Windows: el bash de Git
 * traduce `/tmp` a la carpeta temporal del usuario, y Node lee `C:\tmp\e2ecfg.json`, que no existe — el portón E2E
 * quedaría sin configuración y el paso se saltaría en silencio. Por eso la ruta sale de UN lugar, `lib/tmp-path.js`,
 * y quien escribe y quien lee usan la misma variable.
 *
 *   · `tmpPath(nombre)` con las tres plataformas inyectadas: la misma ruta para el que escribe y el que lee, dentro
 *     de la carpeta temporal de esa plataforma; en Windows con barras `/` (las entienden el bash de Git y Node);
 *   · un archivo por repo y por sesión: dos pipelines a la vez no se pisan
 *     la configuración, y otra llamada de la misma sesión sobre el mismo repo llega al mismo archivo;
 *   · por la línea de comandos, en esta máquina: bash escribe en la ruta que imprime, y Node lee lo mismo;
 *   · ningún paso ni guion de la skill nombra `/tmp/e2ecfg.json` a mano, ni lee la configuración con un `require`
 *     de una ruta fija; quien la escribe y quien la lee pasan por `"$E2ECFG"`;
 *   · ningún paso le pide al asistente abrir un archivo con `open` (sólo existe en Mac).
 *
 * 🔴 Nada acá toca la carpeta temporal real: la prueba de la línea de comandos corre con TMPDIR en una carpeta propia.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/tmp-path.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL = path.resolve(__dirname, '..', '..');
const LIB = path.join(SKILL, 'scripts', 'lib', 'tmp-path.js');

/** Los pasos (`steps/*.md`), el SKILL.md y los guiones de la skill (`scripts/**`, sin las pruebas). */
function skillTexts() {
  const out = [];
  out.push(path.join(SKILL, 'SKILL.md'));
  for (const f of fs.readdirSync(path.join(SKILL, 'steps'))) if (f.endsWith('.md')) out.push(path.join(SKILL, 'steps', f));
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'node_modules') walk(p); continue; }
      if (/\.(js|sh|md)$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(SKILL, 'scripts'));
  // el cierre (`tycon-merge-to-main`) corre el mismo portón E2E con el mismo archivo: la misma regla
  const merge = path.join(SKILL, '..', 'tycon-merge-to-main', 'SKILL.md');
  if (fs.existsSync(merge)) out.push(merge);
  return out.map((f) => ({ file: path.relative(SKILL, f), text: fs.readFileSync(f, 'utf8') }));
}

test('TmpPath_OneWriterOneReader_NoFixedTmpInSteps_NoOpen', async (t) => {
  const { tmpPath } = require(LIB);

  await t.test('la misma ruta para quien escribe y quien lee, en las tres plataformas', () => {
    const cases = [
      { platform: 'darwin', tmpdir: '/var/folders/ab/xyz/T', want: /^\/var\/folders\/ab\/xyz\/T\/tycon-e2ecfg-[0-9a-f]{12}\.json$/ },
      { platform: 'linux', tmpdir: '/tmp', want: /^\/tmp\/tycon-e2ecfg-[0-9a-f]{12}\.json$/ },
      { platform: 'win32', tmpdir: 'C:\\Users\\dev\\AppData\\Local\\Temp', want: /^C:\/Users\/dev\/AppData\/Local\/Temp\/tycon-e2ecfg-[0-9a-f]{12}\.json$/ },
    ];
    for (const c of cases) {
      const writer = tmpPath('e2ecfg', { platform: c.platform, tmpdir: c.tmpdir, repo: '/acme/repo', session: 'sesion-1' });
      const reader = tmpPath('e2ecfg', { platform: c.platform, tmpdir: c.tmpdir, repo: '/acme/repo', session: 'sesion-1' });
      assert.match(writer, c.want, `${c.platform}: la ruta`);
      assert.strictEqual(reader, writer, `${c.platform}: quien lee usa la misma ruta que quien escribe`);
    }
    const win = tmpPath('e2ecfg', { platform: 'win32', tmpdir: 'D:\\temp dir\\Tmp' });
    assert.ok(path.win32.isAbsolute(win) && /^[A-Za-z]:\//.test(win), `en Windows, una ruta con su unidad: ${win}`);
    assert.ok(!win.includes('\\'), 'en Windows sin barras invertidas: el bash de Git y Node la leen igual');
    assert.ok(!win.startsWith('/tmp'), 'en Windows nunca /tmp: Node la leería como C:\\tmp');
  });

  // Una ruta igual para todas las sesiones y todos los repos haría que dos
  // pipelines a la vez (worktrees) escribieran el mismo archivo, y uno correría el portón E2E del repo del otro.
  await t.test('dos repos, o dos sesiones, nunca comparten el archivo; el mismo repo y sesión, siempre el mismo', () => {
    const base = { platform: 'linux', tmpdir: '/tmp' };
    const a = tmpPath('e2ecfg', { ...base, repo: '/acme/repo-a', session: 's1' });
    const b = tmpPath('e2ecfg', { ...base, repo: '/acme/repo-b', session: 's1' });
    const a2 = tmpPath('e2ecfg', { ...base, repo: '/acme/repo-a', session: 's2' });
    assert.notStrictEqual(a, b, 'dos repos de la misma sesión, el mismo archivo');
    assert.notStrictEqual(a, a2, 'el mismo repo en dos sesiones, el mismo archivo');
    assert.strictEqual(tmpPath('e2ecfg', { ...base, repo: '/acme/repo-a/', session: 's1' }), a, 'la barra final no cambia el repo');
  });

  await t.test('por la línea de comandos: el bloque del paso 7c en dos repos a la vez no se pisa', (t2) => {
    const bash = spawnSync('bash', ['-c', 'exit 0']);
    if (bash.error || bash.status !== 0) { t2.skip('NO MEDIDO — esta máquina no tiene bash'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-path-dos-'));
    try {
      const repos = ['repo-a', 'repo-b'].map((n) => { const p = path.join(dir, n); fs.mkdirSync(p); return p; });
      // la misma carpeta de trabajo y la misma sesión para los dos: sólo el repo los distingue
      const env = Object.assign({}, process.env, { TMPDIR: dir, TMP: dir, TEMP: dir, LIB, CLAUDE_CODE_SESSION_ID: 'sesion-acme' });
      const script = [
        'set -e',
        'for i in $(seq 1 15); do',
        '  P=$(node "$LIB" e2ecfg "$REPO")',
        '  echo "{\\"gate\\":\\"$(basename "$REPO")\\"}" > "$P"',
        '  G=$(node -e \'process.stdout.write(require(process.argv[1]).gate||"")\' "$P")',
        '  [ "$G" = "$(basename "$REPO")" ] || { echo "vuelta $i: leí el gate de $G"; exit 7; }',
        'done',
      ].join('\n');
      const corridas = repos.map((REPO) => require('child_process').spawn('bash', ['-c', script], { env: { ...env, REPO }, cwd: dir }));
      const fin = corridas.map((h) => new Promise((resolve) => { let out = ''; h.stdout.on('data', (d) => { out += d; }); h.on('close', (c) => resolve({ c, out })); }));
      return Promise.all(fin).then((rs) => {
        for (const r of rs) assert.strictEqual(r.c, 0, `una sesión leyó la configuración del otro repo: ${r.out}`);
        const [pa, pb] = repos.map((REPO) => spawnSync(process.execPath, [LIB, 'e2ecfg', REPO], { env, cwd: dir, encoding: 'utf8' }).stdout.trim());
        assert.notStrictEqual(pa, pb, 'los dos repos reciben la misma ruta');
        const otraVez = spawnSync(process.execPath, [LIB, 'e2ecfg', repos[0]], { env, cwd: dir, encoding: 'utf8' }).stdout.trim();
        assert.strictEqual(otraVez, pa, 'otro proceso de la misma sesión y repo (otra llamada de Bash) llega al mismo archivo');
      }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
    } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  });

  await t.test('un nombre que no es una palabra simple no arma ruta', () => {
    for (const bad of ['', '../x', 'a/b', 'a\\b', 'E2E CFG', '.hidden']) {
      assert.throws(() => tmpPath(bad, { platform: 'linux', tmpdir: '/tmp' }), /nombre/, `«${bad}» se rechaza`);
    }
  });

  await t.test('por la línea de comandos: bash escribe donde dice, y Node lee lo mismo', (t2) => {
    const bash = spawnSync('bash', ['-c', 'exit 0']);
    if (bash.error || bash.status !== 0) { t2.skip('NO MEDIDO — esta máquina no tiene bash'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-path-'));
    try {
      const env = Object.assign({}, process.env, { TMPDIR: dir, TMP: dir, TEMP: dir, LIB });
      const script = [
        'P=$(node "$LIB" e2ecfg) || exit 9',
        'echo \'{"gate":"scripts/e2e.sh"}\' > "$P"',
        'node -e \'process.stdout.write(require(process.argv[1]).gate||"")\' "$P"',
      ].join('\n');
      const r = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
      assert.strictEqual(r.status, 0, `salió ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.stdout, 'scripts/e2e.sh', 'Node leyó lo que escribió bash');
      const printed = spawnSync(process.execPath, [LIB, 'e2ecfg'], { env, encoding: 'utf8' });
      assert.strictEqual(printed.status, 0);
      assert.ok(fs.existsSync(printed.stdout.trim()), `el archivo quedó en la ruta impresa: ${printed.stdout.trim()}`);
      assert.ok(fs.realpathSync(path.dirname(printed.stdout.trim())) === fs.realpathSync(dir), 'dentro de la carpeta temporal de la máquina');
      const bad = spawnSync(process.execPath, [LIB, '../afuera'], { env, encoding: 'utf8' });
      assert.strictEqual(bad.status, 2, 'un nombre inválido es un error de uso');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await t.test('ningún paso ni guion nombra /tmp/e2ecfg.json, y quien escribe y quien lee usan "$E2ECFG"', () => {
    const texts = skillTexts();
    assert.ok(texts.length > 20, `sólo ${texts.length} archivos leídos: el lector no leyó la skill`);
    const fixed = texts.filter((x) => x.text.includes('/tmp/e2ecfg'));
    assert.deepStrictEqual(fixed.map((x) => x.file), [], 'nombran /tmp/e2ecfg.json a mano');
    const fixedRequire = texts.filter((x) => /require\(\s*["'`]\/tmp\//.test(x.text));
    assert.deepStrictEqual(fixedRequire.map((x) => x.file), [], 'leen con require() una ruta fija bajo /tmp');
    // el nombre del archivo, en minúsculas (`e2eCfg`, la variable de pipeline.js, no es un usuario del archivo)
    const users = texts.filter((x) => /e2ecfg/.test(x.text));
    assert.ok(users.some((x) => x.file === path.join('steps', 'step-10-live-check.md')), 'el paso 7c usa la configuración de E2E');
    assert.ok(users.some((x) => x.file === path.join('scripts', 'on-frontmatter-write.js')), 'on-frontmatter-write.js la sugiere');
    for (const x of users.filter((u) => u.file !== path.join('scripts', 'lib', 'tmp-path.js'))) {
      assert.match(x.text, /E2ECFG=\$\(node [^\n)]*\/scripts\/lib\/tmp-path\.js e2ecfg <repo>\)/, `${x.file}: la ruta sale de tmp-path.js`);
      // la ruta depende del repo: cada llamada se lo pasa, ninguna lo omite
      const sinRepo = x.text.split('\n').filter((l) => /tmp-path\.js e2ecfg/.test(l) && !/tmp-path\.js e2ecfg <repo>\)/.test(l));
      assert.deepStrictEqual(sinRepo.map((l) => l.trim()), [], `${x.file}: arma la ruta sin pasarle el repo`);
      // quien escribe: la salida de `pipeline.js e2e-config` va a "$E2ECFG" (también con la línea partida con «\»)
      const writes = [...x.text.replace(/\\\n\s*/g, ' ').matchAll(/pipeline\.js e2e-config[^\n]*/g)].map((m) => m[0]);
      assert.ok(writes.length > 0, `${x.file}: no encontré quién escribe la configuración`);
      for (const w of writes) assert.match(w, />\s*"\$E2ECFG"/, `${x.file}: escribe en otra ruta: ${w}`);
      // quien lee: cada `require(` de la configuración recibe la ruta por argumento, con "$E2ECFG"
      const reads = x.text.split('\n').filter((l) => /node -e/.test(l) && /require\(/.test(l) && /(gate|frontend_dir|warning)/.test(l));
      assert.ok(reads.length > 0, `${x.file}: no encontré quién lee la configuración`);
      for (const l of reads) assert.match(l, /require\(process\.argv\[1\]\)[\s\S]*"\$E2ECFG"/, `${x.file}: lee otra ruta: ${l.trim()}`);
    }
  });

  await t.test('ningún paso le pide al asistente abrir un archivo con open', () => {
    const OPEN = /(^|[\s`;&|(])(?:xdg-)?open\s+(?=["'.~/$<A-Za-z])/;
    const steps = skillTexts().filter((x) => x.file === 'SKILL.md' || x.file.startsWith(`steps${path.sep}`));
    assert.ok(steps.length >= 10, `sólo ${steps.length} pasos leídos`);
    const hits = [];
    for (const x of steps) x.text.split('\n').forEach((l, i) => { if (OPEN.test(l)) hits.push(`${x.file}:${i + 1}: ${l.trim()}`); });
    assert.deepStrictEqual(hits, [], 'piden abrir un archivo con open');
    assert.ok(OPEN.test('   open .advisors/plan.html   # macOS'), 'control positivo: el detector reconoce el pedido viejo');
  });
});
