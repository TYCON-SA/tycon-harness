'use strict';

/**
 * code-comments.test.js — el freno de historia interna en los comentarios del código (scripts/publishing/internal-history.js,
 * zona `comment`). La regla: guides/maintaining/estilo-de-codigo.md.
 *
 * Lo que no se puede perder:
 *   · Que el lector mire sólo los comentarios: ni el código ni las cadenas, y con la línea real del archivo.
 *   · Que un commit que AGREGA historia a un comentario no se cree, y que tocar un archivo viejo con historia en otras
 *     líneas, renombrarlo o reescribir esa línea conservando la referencia no frene.
 *   · Que el mensaje diga archivo, línea, forma y qué hacer en una línea, sin repetir el texto.
 *   · Que corra igual sobre el diff de un pedido armado como lo arma la revisión del público, y que sólo mire el árbol que
 *     se publica.
 *
 * Arma repos de juguete con git de verdad. Los ejemplos rojos se escriben por partes (`j`): este archivo se publica, y el
 * propio freno no deja pasar una referencia interna escrita de corrido en un comentario.
 *
 * Uso: node --test scripts/tests/code-comments.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const GUARD = path.join(RAIZ, 'scripts', 'publishing', 'internal-history.js');
const HOOK = path.join(RAIZ, '.githooks', 'pre-commit-checks');
const PUBLIC_CI = path.join(RAIZ, 'scripts', 'ci', 'public-ci.sh');
const ALLOWED = 'scripts/tests/fixtures/internal-history-allowed.json';
const ih = require(GUARD);
const j = (...parts) => parts.join('');

// ── los ejemplos, por partes: uno rojo y uno verde por forma de la zona ───────────────────────────────────────────
const RED = {
  'story-number': j('(story ', '8.12)'),
  'story-bare': j('desde la ', '8.9 es así'),
  'batch-code': j('en la tanda ', 'B2'),
  'incident-log': j('incident-log.md', '#caso-x'),
  'debt-id': j('DEF-', '8.10.1-19-historia'),
  'azure-run': j('la corrida #', '12511'),
  'pr-number': j('el PR', ' 1234'),
  'private-commit': j('hasta el commit ', '`c6cbe1d4`'),
  'work-branch': j('story/', '8.26-G'),
  'owner-decision': j('(decisión del dueño, ', 'según el plan)'),
  date: j('medido así el 20', '26-10-06'),
  history: j('antes ', 'era otro'),
};
const GREEN = {
  'story-number': 'la story que se implementa, `story <N.M>`',
  'story-bare': 'la versión 3 de la lista',
  'batch-code': 'por tanda, cada tanda, la tanda siguiente',
  'incident-log': 'el registro de incidentes no se publica',
  'debt-id': 'una deuda declarada, `DEF-<story>-<nombre>`',
  'azure-run': 'la corrida de la validación, con 12511 líneas',
  'pr-number': 'un pull request, el pedido de cambio',
  'private-commit': 'el commit que lo retiró',
  'work-branch': 'la rama `feature/mi-cambio`',
  'owner-decision': 'pausa para decisión del dev',
  date: 'una fecha con la forma AAAA-MM-DD',
  history: 'corre hasta que termina el lote; antes de leer, valida',
};
const COMMENT_FORMS = Object.keys(RED);

// ── git del laboratorio: sin la configuración de la máquina ni las variables que git le pasa a sus hooks ─────────
function cleanEnv(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && !k.startsWith('TYCON_') && k !== 'NODE_TEST_CONTEXT') e[k] = v;
  return {
    ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    ...extra,
  };
}
function git(dir, args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-C', dir, ...args], { env: cleanEnv(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (${dir}): ${r.stderr}`);
  return r.stdout.trim();
}
function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    if (content === null) { fs.rmSync(abs, { recursive: true, force: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}
const stage = (repo, files) => { write(repo, files); git(repo, ['add', '-A']); };
const commit = (repo, msg) => { git(repo, ['commit', '-q', '-m', msg]); return git(repo, ['rev-parse', 'HEAD']); };

const created = [];
test.after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); created.push(d); return d; };

/** La configuración de verdad con formas de la zona en otro modo. */
function configWith(forms) {
  const real = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'internal-history.json'), 'utf8'));
  for (const [form, mode] of Object.entries(forms)) real.zones.comment.forms[form] = { ...real.zones.comment.forms[form], mode };
  const file = path.join(tmp('code-comments-config'), 'config.json');
  fs.writeFileSync(file, JSON.stringify(real));
  return file;
}

/** El freno en la zona de comentarios, parado en el repo, con la HOME del laboratorio. */
function guard(l, { args = [], env = {}, mode = 'block' } = {}) {
  const r = spawnSync(process.execPath, [GUARD, '--repo', l.repo, '--zone', 'comment', ...args], {
    cwd: l.repo, encoding: 'utf8',
    env: cleanEnv({ HOME: l.home, USERPROFILE: l.home, ...(mode ? { TYCON_INTERNAL_HISTORY: mode } : {}), ...env }),
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
}

// ── el laboratorio con la forma del repo público: un guion viejo que ya trae historia ──────────────────────────────
const OLD_JS = `'use strict';\n// Lee la lista ${RED['story-number']}.\nconst a = 1;\n// Otra nota en presente.\nmodule.exports = a;\n`;
function publicLab() {
  const dir = tmp('code-comments-public');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(dir, 'home'));
  git(repo, ['init', '-q', '-b', 'main']);
  write(repo, {
    'README.md': '# Arnés de juguete\n',
    'scripts/old.js': OLD_JS,
    'scripts/run.sh': '#!/usr/bin/env bash\n# Corre el lote.\necho ok\n',
  });
  git(repo, ['add', '-A']); commit(repo, 'base');
  return { dir, repo, home: path.join(dir, 'home') };
}

// ══ T1 · el lector ════════════════════════════════════════════════════════════════════════════════════════════════

test('T1 CommentZone_ReadsOnlyComments — sólo los comentarios, con la línea real y sin código ni cadenas', () => {
  const js = [
    '#!/usr/bin/env node',
    `const s = "${RED['story-number']}"; // nota al final`,
    '/* un bloque',
    ' * que sigue',
    ' */',
    'const url = "http://example.com/x"; const b = 2;',
    `// ${RED.date}`,
  ].join('\n');
  const c = ih.commentsOf(js, 'scripts/a.js').split('\n');
  assert.strictEqual(c.length, 7, 'las mismas líneas que el archivo');
  assert.strictEqual(c[0].trim(), '', 'el shebang no es comentario');
  assert.strictEqual(c[1].trim(), 'nota al final', 'el comentario del final de una línea, sin la cadena');
  assert.strictEqual(c[2].trim(), 'un bloque');
  assert.strictEqual(c[3].trim(), 'que sigue');
  assert.strictEqual(c[5].trim(), '', 'una barra doble dentro de una cadena no es comentario');
  assert.deepStrictEqual(ih.scan(ih.commentsOf(js, 'scripts/a.js'), 'comment').map((f) => [f.form, f.line]), [['date', 7]], 'la cadena con la story no cuenta; la fecha del comentario, en su línea');

  const sh = `#!/usr/bin/env bash\n# ${RED['batch-code']}\necho "# no es comentario"\n`;
  assert.deepStrictEqual(ih.scan(ih.commentsOf(sh, 'scripts/x.sh'), 'comment').map((f) => [f.form, f.line]), [['batch-code', 2]]);
  const hookName = ih.commentsOf(`#!/bin/sh\n# ${RED['batch-code']}\n`, '.githooks/pre-commit-checks');
  assert.strictEqual(ih.scan(hookName, 'comment').length, 1, 'un hook sin extensión se lee como guion de shell');
  const ps1 = `<#\n ${RED['debt-id']}\n#>\nWrite-Host "x" # ${RED.history}\n`;
  assert.deepStrictEqual(ih.scan(ih.commentsOf(ps1, 'scripts/x.ps1'), 'comment').map((f) => [f.form, f.line]), [['debt-id', 2], ['history', 4]]);
  const yml = `steps:\n  - run: echo hola # ${RED['azure-run']}\n`;
  assert.deepStrictEqual(ih.scan(ih.commentsOf(yml, 'p/x.yml'), 'comment').map((f) => f.form), ['azure-run']);
  const crlf = `// uno\r\n// ${RED['story-bare']}\r\nx();\r\n`;
  assert.deepStrictEqual(ih.scan(ih.commentsOf(crlf, 'a.js'), 'comment').map((f) => [f.form, f.line]), [['story-bare', 2]], 'con finales de línea de Windows');
  assert.deepStrictEqual(ih.scan(ih.commentsOf(`# ${RED.date}\n`, 'notas.md'), 'comment'), [], 'un archivo que no es código no tiene comentarios');
});

/** Las formas que el lector encuentra en un texto, con su línea. */
const hits = (text, rel) => ih.scan(ih.commentsOf(text, rel), 'comment').map((f) => [f.form, f.line]);
const SN = j('story ', '8.9');
const DT = j('20', '26-01-01');

test('T1b CommentZone_LexerFollowsTheLanguage — bloques a mitad de línea, cadenas, expresiones regulares y heredocs', () => {
  // JavaScript: un bloque después de código, uno que sigue en otras líneas, lo que viene después de cerrarlo
  assert.deepStrictEqual(hits(`foo(); /* medido así el ${DT} */`, 'a.js'), [['date', 1]]);
  assert.deepStrictEqual(hits(`foo(); /* empieza\n  la ${SN} siguió\n */`, 'a.js'), [['story-number', 2]]);
  assert.deepStrictEqual(hits(`/* a\n b */ bar(); // ${SN}`, 'a.js'), [['story-number', 2]]);
  assert.deepStrictEqual(hits(`{/* ${SN} */}`, 'a.jsx'), [['story-number', 1]], 'el comentario de JSX');
  // una comilla dentro de una expresión regular no abre una cadena; una división tampoco abre una expresión
  assert.deepStrictEqual(hits(`x.replace(/'/g, ''); // ${SN}`, 'a.js'), [['story-number', 1]]);
  assert.deepStrictEqual(hits(`x.split(/"/); // ${SN}`, 'a.js'), [['story-number', 1]]);
  assert.deepStrictEqual(hits(`a = b / c; // ${SN}`, 'a.js'), [['story-number', 1]]);
  assert.deepStrictEqual(hits(`x();// ${SN}`, 'a.js'), [['story-number', 1]], 'pegado al código también es comentario');
  // las cadenas no son comentarios: tampoco una plantilla de varias líneas ni una dirección con barras
  assert.deepStrictEqual(hits(`const t = \`\n// ${SN}\n\`;`, 'a.js'), []);
  assert.deepStrictEqual(hits(`const g = \`/*\`; x(); // ${DT}`, 'a.js'), [['date', 1]], 'un `/*` dentro de una plantilla no abre un bloque');
  assert.deepStrictEqual(hits(`const s = \`a \${b ? '/*' : ''} c\`; // ${DT}`, 'a.ts'), [['date', 1]], 'con una expresión adentro');
  assert.deepStrictEqual(hits(`const u = "http://x.example/${SN}";`, 'a.js'), []);

  // shell: la barra es literal entre comillas simples; `;#` abre un comentario; `${#x}` y `$#` no; un heredoc es datos
  assert.deepStrictEqual(hits(`echo 'a\\' # ${SN}`, 'x.sh'), [['story-number', 1]]);
  assert.deepStrictEqual(hits(`x=1;# ${SN}`, 'x.sh'), [['story-number', 1]]);
  assert.deepStrictEqual(hits('echo ${#arr[@]} $#\n', 'x.sh'), []);
  assert.deepStrictEqual(hits(`cat <<'EOF'\n# ${SN}\nEOF\n# ${DT}`, 'x.sh'), [['date', 4]]);
  assert.deepStrictEqual(hits(`cat <<-EOF\n\t# ${SN}\n\tEOF\n# ${DT}`, 'x.bash'), [['date', 4]]);

  // PowerShell: la barra es literal; `<# … #>` en cualquier lugar; un here-string es datos
  assert.deepStrictEqual(hits(`$p = "C:\\temp\\" # ${SN}`, 'x.ps1'), [['story-number', 1]]);
  assert.deepStrictEqual(hits(`$a = 1 <# ${SN} #>`, 'x.ps1'), [['story-number', 1]]);
  assert.deepStrictEqual(hits(`<# a #> $x = 1 # ${SN}`, 'x.ps1'), [['story-number', 1]]);
  assert.deepStrictEqual(hits(`$t = @'\n# ${SN}\n'@\n# ${DT}`, 'x.ps1'), [['date', 4]]);

  // Python y TOML: la triple comilla es datos
  assert.deepStrictEqual(hits(`"""\n# ${SN}\n"""\nx = 1  # ${DT}`, 'x.py'), [['date', 4]]);
  assert.deepStrictEqual(hits(`a = "#x"  # ${SN}`, 'x.toml'), [['story-number', 1]]);
  // YAML: un `#` dentro de un escalar entre comillas no es comentario
  assert.deepStrictEqual(hits(`k: "a # b" # ${SN}`, 'x.yml'), [['story-number', 1]]);
  assert.deepStrictEqual(hits(`k: 'it''s # no' # ${SN}`, 'x.yaml'), [['story-number', 1]]);

  // los guiones con otras extensiones y los Dockerfile también son código
  for (const rel of ['scripts/x.command', 'x.command.template', 'x.zsh', 'a.mts', 'a.cts', 'Dockerfile', 'scripts/site/Dockerfile.copy']) {
    assert.ok(ih.isCodeFile(rel), `${rel}: se lee`);
    assert.strictEqual(hits(`#!/bin/bash\n${/\.(?:mts|cts)$/.test(rel) ? '//' : '#'} ${SN}\n`, rel).length, 1, `${rel}: su comentario`);
  }
  assert.ok(!ih.isCodeFile('README.md') && !ih.isCodeFile('scripts/x.json'), 'la prosa y los datos no son de esta zona');
});

test('T1c CommentZone_LexerEdges — los bordes de cada lenguaje', () => {
  const cases = [
    // JavaScript
    [`const r = /[/]/; // ${SN}`, 'a.js', [['story-number', 1]]],
    [`const r = /a\\/\\/b/; // ${SN}`, 'a.js', [['story-number', 1]]],
    [`const t = \`a \${\`b \${c}\`} d\`; // ${SN}`, 'a.js', [['story-number', 1]]],
    [`const t = \`\${ { a: 1 }.a }\`; // ${SN}`, 'a.js', [['story-number', 1]]],
    [`const s = 'it\\'s // no'; // ${SN}`, 'a.js', [['story-number', 1]]],
    [`const s = "sin cerrar\n// ${SN}`, 'a.js', [['story-number', 2]]],
    // shell
    [`cat <<< "x" # ${SN}`, 'x.sh', [['story-number', 1]]],
    [`echo "# no ${SN}" # ${DT}`, 'x.sh', [['date', 1]]],
    [`echo \\# no ${SN}`, 'x.sh', []],
    [`cat <<EOF\n# ${SN}\nEOF\n# ${DT}`, 'x.sh', [['date', 4]]],
    [`cat <<A <<"B"\n# ${SN}\nA\n# ${SN}\nB\n# ${DT}`, 'x.sh', [['date', 6]]],
    [`echo "a\n# ${SN}\nb" # ${DT}`, 'x.sh', [['date', 3]]],
    [`cat <<'EOF'\r\n# ${SN}\r\nEOF\r\n# ${DT}\r\n`, 'x.sh', [['date', 4]]],
    // PowerShell
    [`$t = @"\n# ${SN}\n"@\n# ${DT}`, 'x.ps1', [['date', 4]]],
    [`$s = "a\`" # no ${SN}" # ${DT}`, 'x.ps1', [['date', 1]]],
    [`$s = 'it''s # no ${SN}' # ${DT}`, 'x.ps1', [['date', 1]]],
    [`$s = 'a\n# ${SN}\nb' # ${DT}`, 'x.ps1', [['date', 3]]],
    [`<# abierto\n${SN}`, 'x.ps1', [['story-number', 2]]],
    [`<# a #>\r\n# ${SN}\r\n`, 'x.ps1', [['story-number', 2]]],
    // Python
    [`'''\n# ${SN}\n'''\n# ${DT}`, 'x.py', [['date', 4]]],
    [`x = """# no"""  # ${DT}`, 'x.py', [['date', 1]]],
    [`x = "a\\"# no"  # ${DT}`, 'x.py', [['date', 1]]],
    [`"""\n# ${SN}`, 'x.py', []],
    // YAML
    [`k: "a\\"# no" # ${SN}`, 'x.yml', [['story-number', 1]]],
    [`k: a#b ${SN}`, 'x.yml', []],
    [`run: |\n  # ${SN}\n  echo hola`, 'x.yml', [['story-number', 2]]],
    [`k: v # ${SN}\r\n`, 'x.yml', [['story-number', 1]]],
    // Dockerfile: sólo las líneas que empiezan con #
    [`# syntax=docker/dockerfile:1\nRUN echo hola # ${SN}\n# ${DT}`, 'Dockerfile', [['date', 3]]],
    // lo que no puede apagar la lectura del resto del archivo
    [`x=$(( 1 << n ))\n# ${SN}`, 'x.sh', [['story-number', 2]]],
    [`echo $'it\\'s' # ${SN}\n# ${DT}`, 'x.sh', [['story-number', 1], ['date', 2]]],
    [`echo it's\n# ${SN}`, 'x.sh', [['story-number', 2]]],
    [`const s = "a\\\nb";\n// ${SN}`, 'a.js', [['story-number', 3]]],
    [`if (x) /\`/.test(y);\n// ${SN}`, 'a.js', [['story-number', 2]]],
    [`cat <<EOF\n# ${SN}`, 'x.sh', [['story-number', 2]]],
    [`cat <<\\EOF\nit's\nEOF\n# ${SN}`, 'x.sh', [['story-number', 4]]],
    [`const a = i++ / 2; // ${SN}`, 'a.js', [['story-number', 1]]],
    [`const a = x.delete / 2; // ${SN}`, 'a.js', [['story-number', 1]]],
    [`cat <<<"w"\n# ${SN}\nw`, 'x.sh', [['story-number', 2]]],
    [`const v = <p>hola</p>; // ${SN}`, 'a.jsx', [['story-number', 1]]],
    [`const v = <p>x</p>{/* ${SN} */};`, 'a.tsx', [['story-number', 1]]],
    [`echo $'sin cierre\n# ${SN}`, 'x.sh', [['story-number', 2]]],
    [`return /'/.test(x); // ${SN}`, 'a.js', [['story-number', 1]]],
    [`const a = (b) / 2; const c = {}.x / 3; // ${SN}`, 'a.js', [['story-number', 1]]],
    [`const t = \`a\\\nb\`;\n// ${SN}`, 'a.js', [['story-number', 3]]],
    // bordes de la entrada
    ['', 'a.js', []],
    [`// ${SN}`, 'a.js', [['story-number', 1]]],
  ];
  for (const [text, rel, want] of cases) assert.deepStrictEqual(hits(text, rel), want, `${rel}: ${JSON.stringify(text).slice(0, 80)}`);
});

test('T7b CommentGuard_CannotLookIsTwo — los errores de verdad del freno salen 2, nunca un verde', () => {
  const l = publicLab();
  stage(l.repo, { 'scripts/new.js': `// ${RED.date}\n` });
  assert.strictEqual(guard(l, { args: ['--config', path.join(l.dir, 'no-existe.json')] }).code, 2, 'configuración ausente');
  const bad = path.join(l.dir, 'rota.json');
  fs.writeFileSync(bad, '{ no es json');
  assert.strictEqual(guard(l, { args: ['--config', bad] }).code, 2, 'configuración rota');
  const z = spawnSync(process.execPath, [GUARD, '--repo', l.repo, '--zone', 'code'], { cwd: l.repo, encoding: 'utf8', env: cleanEnv({ HOME: l.home }) });
  assert.strictEqual(z.status, 2, 'una zona que no se pide');
  const k = publicLab();
  stage(k.repo, { 'scripts/new.js': `// ${RED.date}\n`, [ALLOWED]: '{ no es json' });
  assert.strictEqual(guard(k).code, 2, 'la lista de excepciones rota');
  assert.strictEqual(guard(l, { args: ['--range', 'no-existe...HEAD'] }).code, 2, 'una base que no es un commit');
  const b = publicLab();
  write(b.repo, { 'scripts/bin.js': null });
  fs.writeFileSync(path.join(b.repo, 'scripts', 'bin.js'), Buffer.from([0xff, 0xfe, 0x00, 0x2f, 0x2f]));
  git(b.repo, ['add', '-A']);
  assert.strictEqual(guard(b).code, 2, 'un archivo de código que no es UTF-8');
});

test('T2b CommentZone_HistoryFormPrecision — los plurales cuentan; las frases en presente no', () => {
  assert.deepStrictEqual(hits('// antes eran tres\n// antes frenaban\n', 'a.js').map((h) => h[0]), ['history', 'history']);
  assert.deepStrictEqual(hits('// devuelve null si no se encontró\n// un caso real de uso\n', 'a.js'), []);
  assert.deepStrictEqual(hits('// Caso real: un pedido sin su prueba\n', 'a.js'), [['history', 1]]);
  assert.deepStrictEqual(hits(`// ver ${j('incident-', 'log.md#caso-x')}\n`, 'a.js'), [['incident-log', 1]], 'el registro con ancla cuenta una vez, no también como ruta');
});

// ══ T2 · las formas ═══════════════════════════════════════════════════════════════════════════════════════════════

test('T2 CommentZone_FormsCatchTheirCase — cada forma ve su rojo en un comentario y deja pasar su verde', () => {
  for (const form of COMMENT_FORMS) {
    const red = ih.scan(ih.commentsOf(`x();\n// ${RED[form]}\n`, 'a.js'), 'comment').filter((f) => f.form === form);
    assert.strictEqual(red.length, 1, `${form}: su rojo se ve una vez`);
    assert.strictEqual(red[0].line, 2, `${form}: en su línea`);
    assert.deepStrictEqual(ih.scan(ih.commentsOf(`// ${GREEN[form]}\n`, 'a.js'), 'comment').filter((f) => f.form === form), [], `${form}: su verde pasa`);
  }
  const tags = j('// ── C-63 · Etapa_SinTerminales @sto', 'ry-2.21 @ac-7 ──\n');
  assert.deepStrictEqual(ih.scan(ih.commentsOf(tags, 'a.test.js'), 'comment'), [], 'las marcas de la matriz por criterio no son historia');
  assert.deepStrictEqual(ih.scan(ih.commentsOf('// sigue hasta que alguien lo cierre\n', 'a.js'), 'comment'), [], '«hasta que» como conjunción');
  const path1 = j('// la lista excluye guides/maintaining/incident-', 'log.md\n');
  assert.deepStrictEqual(ih.scan(ih.commentsOf(path1, 'a.js'), 'comment').map((f) => f.form), ['incident-log-path'], 'la ruta suelta es su propia forma (sólo avisa)');
});

test('T3 CommentZone_WeakFormsAreNotForms — «ya no», «ahora» y «pase adversarial» no son hallazgos', () => {
  const weak = '// el commit ya no está\n// ahora mira los dos\n// el pase adversarial corre al final\n';
  assert.deepStrictEqual(ih.scan(ih.commentsOf(weak, 'a.js'), 'comment'), []);
});

// ══ T4 · la cuenta de todo ════════════════════════════════════════════════════════════════════════════════════════

test('T4 CommentZone_AllJson_CountsWithoutText — por forma, carpeta y archivo, sin el texto', () => {
  const l = publicLab();
  stage(l.repo, { 'scripts/lib/b.js': `// ${RED.date}\n// ${RED['batch-code']}\nmodule.exports = 0;\n` });
  commit(l.repo, 'b');
  const r = guard(l, { args: ['--all', '--json'] });
  assert.strictEqual(r.code, 0, r.out);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.zone, 'comment');
  assert.deepStrictEqual(out.forms, { 'story-number': 1, date: 1, 'batch-code': 1 });
  assert.deepStrictEqual(out.folders, { scripts: 1, 'scripts/lib': 2 });
  assert.deepStrictEqual(out.files, { 'scripts/lib/b.js': { date: 1, 'batch-code': 1 }, 'scripts/old.js': { 'story-number': 1 } });
  assert.strictEqual(out.total, 3);
  for (const v of [RED.date, RED['batch-code'], RED['story-number']]) assert.ok(!r.out.includes(v), `nunca el texto encontrado («${v.slice(0, 12)}…»)`);
});

// ══ T5 · lo nuevo, y sólo lo nuevo ════════════════════════════════════════════════════════════════════════════════

test('T5 CommentGuard_AddedLineBlocks_MoveDoesNot — frena lo que suma historia; lo viejo no', () => {
  const cases = [
    ['otra línea del archivo viejo', { 'scripts/old.js': OLD_JS.replace('Otra nota en presente.', 'Otra nota, reescrita.') }, 0],
    ['la línea vieja reescrita, con la misma referencia', { 'scripts/old.js': OLD_JS.replace('Lee la lista', 'Lee la lista de nombres') }, 0],
    ['un bloque movido dentro del archivo', { 'scripts/old.js': `'use strict';\nconst a = 1;\n// Lee la lista ${RED['story-number']}.\n// Otra nota en presente.\nmodule.exports = a;\n` }, 0],
    ['una línea nueva con historia', { 'scripts/run.sh': `#!/usr/bin/env bash\n# Corre el lote ${RED['batch-code']}.\necho ok\n` }, 1],
    ['la misma referencia, una vez más', { 'scripts/old.js': `${OLD_JS}// Y otra vez ${RED['story-number']}.\n` }, 1],
    ['un archivo nuevo con historia', { 'scripts/new.js': `// ${RED.date}\n` }, 1],
    ['una cadena con historia (no es comentario)', { 'scripts/run.sh': `#!/usr/bin/env bash\n# Corre el lote.\necho "${RED['batch-code']}"\n` }, 0],
  ];
  for (const [what, files, code] of cases) {
    const l = publicLab();
    stage(l.repo, files);
    const r = guard(l);
    assert.strictEqual(r.code, code, `${what}: ${r.out}`);
  }
  // renombrar el archivo viejo no agrega; copiarlo entero mete la historia en un archivo nuevo, y cuenta (como en la prosa)
  const l = publicLab();
  git(l.repo, ['mv', 'scripts/old.js', 'scripts/renamed.js']);
  assert.strictEqual(guard(l).code, 0, 'un renombre no agrega');
  const k = publicLab();
  stage(k.repo, { 'scripts/copy.js': OLD_JS });
  assert.strictEqual(guard(k).code, 1, 'una copia entera cuenta en el archivo nuevo');
});

test('T6 CommentGuard_ModePerForm — una forma en aviso avisa y sale 0; una que frena sale 1', () => {
  const l = publicLab();
  stage(l.repo, { 'scripts/new.js': `// ${RED.date}\n` });
  const warn = guard(l, { args: ['--config', configWith({ date: 'warn' })] });
  assert.strictEqual(warn.code, 0, warn.out);
  assert.match(warn.out, /scripts\/new\.js:1\s+date/);
  assert.match(warn.out, /avisa/);
  const block = guard(l, { args: ['--config', configWith({ date: 'block' })] });
  assert.strictEqual(block.code, 1, block.out);
  const lowered = guard(l, { mode: 'warn' });
  assert.strictEqual(lowered.code, 0, 'la variable baja la zona, como la prosa');
  assert.match(lowered.out, /zone=comment/);
  // el modo general de la zona escrito en aviso, sin la variable
  const real = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'internal-history.json'), 'utf8'));
  real.zones.comment.mode = 'warn';
  const zoneWarn = path.join(tmp('code-comments-config'), 'config.json');
  fs.writeFileSync(zoneWarn, JSON.stringify(real));
  const written = guard(l, { args: ['--config', zoneWarn], mode: null });
  assert.strictEqual(written.code, 0, written.out);
  assert.match(written.stdout, /zone=comment findings=1 cannot_look=0 mode=warn/);
  // una forma de la zona sin entrada, o con el modo mal escrito, frena: falla cerrado
  assert.strictEqual(ih.formModeOf({ forms: {}, zones: { comment: { forms: {} } } }, 'date', 'comment'), 'block');
  assert.strictEqual(ih.formModeOf({ forms: {}, zones: { comment: { forms: { date: { mode: 'warm' } } } } }, 'date', 'comment'), 'block');
  assert.strictEqual(ih.formModeOf({ forms: {} }, 'date', 'comment'), 'block', 'sin la zona en la configuración');
});

test('T6b CommentGuard_ConfigFromTheBase — un commit o un pedido que baja los modos no se los baja a sí mismo', () => {
  const real = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'internal-history.json'), 'utf8'));
  const lowered = JSON.parse(JSON.stringify(real));
  lowered.zones.comment.mode = 'warn';
  for (const f of Object.keys(lowered.zones.comment.forms)) lowered.zones.comment.forms[f].mode = 'warn';
  // la base versiona la configuración que frena; el commit trae la que avisa
  const l = publicLab();
  stage(l.repo, { 'scripts/publishing/internal-history.json': real });
  commit(l.repo, 'configuración');
  stage(l.repo, { 'scripts/publishing/internal-history.json': lowered, 'scripts/new.js': `// ${RED.date}\n` });
  const r = guard(l, { mode: null });
  assert.strictEqual(r.code, 1, r.out);
  // lo mismo sobre el rango de un pedido: la configuración que trae la punta no rige para ese pedido
  const tipBase = git(l.repo, ['rev-parse', 'HEAD']);
  commit(l.repo, 'bajada');
  const pr = guard(l, { args: ['--range', `${tipBase}...HEAD`], mode: null });
  assert.strictEqual(pr.code, 1, pr.out);
  // con la configuración bajada ya en la base, el commit siguiente avisa
  stage(l.repo, { 'scripts/other.js': `// ${RED.date}\n` });
  const next = guard(l, { mode: null });
  assert.strictEqual(next.code, 0, next.out);
  assert.match(next.stdout, /mode=warn/);
  // una configuración de la base que no se entiende es «no pude mirar»
  const k = publicLab();
  stage(k.repo, { 'scripts/publishing/internal-history.json': { mode: 'block' } });
  commit(k.repo, 'sin forms');
  stage(k.repo, { 'scripts/new.js': `// ${RED.date}\n` });
  assert.strictEqual(guard(k).code, 2, 'la base sin «forms»');
});

test('T22 ProseGuard_DecidesByTheBase — la prosa tampoco se apaga con lo que trae el pedido', () => {
  // la misma regla en la zona de la prosa: el tipo de repo sale de la base
  for (const extra of [{ 'team-profile.json': { name: 'acme' } }, { '.tycon/internal-forms.json': { layout: 'thin', own: {} } }]) {
    const l = publicLab();
    stage(l.repo, { ...extra, 'guides/a.md': `# Guía\n\n${RED['batch-code']}\n` });
    const r = spawnSync(process.execPath, [GUARD, '--repo', l.repo], { cwd: l.repo, encoding: 'utf8', env: cleanEnv({ HOME: l.home, USERPROFILE: l.home, TYCON_INTERNAL_HISTORY: 'block' }) });
    assert.strictEqual(r.status, 1, `${Object.keys(extra)[0]}: ${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /guides\/a\.md:3\s+batch-code/);
  }
});

test('T5b CommentGuard_BlockMovedBetweenFiles — mover un bloque de un archivo a otro cuenta en el destino', () => {
  const l = publicLab();
  stage(l.repo, {
    'scripts/old.js': "'use strict';\nconst a = 1;\n// Otra nota en presente.\nmodule.exports = a;\n",
    'scripts/run.sh': `#!/usr/bin/env bash\n# Lee la lista ${RED['story-number']}.\necho ok\n`,
  });
  const r = guard(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /scripts\/run\.sh:2\s+story-number/);
});

test('T7 CommentGuard_MessageNamesFileLineForm — archivo, línea, forma y qué hacer en una línea; nunca el texto', () => {
  const l = publicLab();
  stage(l.repo, { 'scripts/run.sh': `#!/usr/bin/env bash\n# Corre ${RED['debt-id']}.\necho ok\n` });
  const r = guard(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /scripts\/run\.sh:2\s+debt-id — sacá el código de la deuda/, 'al lado, qué escribir en su lugar');
  for (const form of COMMENT_FORMS) assert.ok(ih.COMMENT_HINTS[form], `${form}: tiene su pista`);
  const todo = r.out.split('\n').filter((x) => /guides\/maintaining\/estilo-de-codigo\.md/.test(x));
  assert.strictEqual(todo.length, 1, 'una sola línea dice qué hacer');
  assert.match(todo[0], /presente/);
  assert.match(todo[0], /internal-history-allowed\.json/);
  assert.ok(!r.out.includes(RED['debt-id']), 'nunca el texto encontrado');
  assert.match(r.stdout.trim().split('\n').pop(), /^internal-history: zone=comment findings=1 cannot_look=0 mode=block/);
  // la constancia propia del freno dice de qué zona es cada decisión (el registro de frenos cuenta el control entero)
  const stateDir = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(l.home);
  const logged = fs.readFileSync(path.join(stateDir, 'internal-history.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.strictEqual(logged.pop().zone, 'comment');
});

test('T8 CommentGuard_AllowedExactValueOnly — una excepción pasa sólo con su archivo, su forma y su valor exactos', () => {
  const value = j('20', '26-11-01');
  const l = publicLab();
  stage(l.repo, {
    'scripts/conf.sh': `#!/usr/bin/env bash\n# La llave vence el ${value}.\n`,
    [ALLOWED]: { allowed: [{ file: 'scripts/conf.sh', form: 'date', value, reason: 'la fecha de vencimiento de la llave' }] },
  });
  assert.strictEqual(guard(l).code, 0, 'declarada, pasa');
  const k = publicLab();
  stage(k.repo, {
    'scripts/conf.sh': `#!/usr/bin/env bash\n# La llave vence el ${j('20', '26-12-01')}.\n`,
    [ALLOWED]: { allowed: [{ file: 'scripts/conf.sh', form: 'date', value, reason: 'la fecha de vencimiento de la llave' }] },
  });
  assert.strictEqual(guard(k).code, 1, 'otro valor no está declarado');
});

// ══ T9 · la prueba de los hooks toma las formas del freno ═════════════════════════════════════════════════════════

test('T9 HookComments_UsesGuardForms — la prueba de los controles del commit lee con el freno', () => {
  // en el código de la prueba, no en un comentario: el lector deja el código afuera, así que se mira lo que no es comentario
  const rel = 'scripts/tests/hook-comments.test.js';
  const src = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
  const comments = ih.commentsOf(src, rel).split('\n');
  const inCode = (re) => src.split('\n').some((l, i) => re.test(l) && !re.test(comments[i]));
  assert.ok(inCode(/ih\.commentsOf\(/), 'usa el lector del freno');
  assert.ok(inCode(/ih\.scan\([^\n]*'comment'\)/), 'con la zona de comentarios');
});

// ══ T20 · la revisión de cada pedido ══════════════════════════════════════════════════════════════════════════════

test('T20 CommentGuard_PrRange_LikeRepoLint — el pedido armado como la revisión del público frena lo que suma', () => {
  // la revisión del público corre el control del commit con la punta en el índice y la base en HEAD
  const ci = fs.readFileSync(PUBLIC_CI, 'utf8');
  assert.match(ci, /reset --quiet --soft "\$\{mb\}"/, 'repo-lint pone HEAD en la base del pedido');
  assert.match(ci, /bash \.githooks\/pre-commit-checks/, 'y corre el control del commit');
  const hook = fs.readFileSync(HOOK, 'utf8');
  assert.match(hook, /node "\$INTERNAL_HISTORY" --repo "\$REPO_ROOT" --zone comment/, 'que llama a la zona de comentarios');

  const l = publicLab();
  const base = git(l.repo, ['rev-parse', 'HEAD']);
  write(l.repo, { 'scripts/run.sh': `#!/usr/bin/env bash\n# Corre ${RED['batch-code']}.\necho ok\n` });
  git(l.repo, ['add', '-A']); commit(l.repo, 'pedido');
  git(l.repo, ['reset', '--quiet', '--soft', base]);
  const r = guard(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /scripts\/run\.sh:2\s+batch-code/);
});

/** El tramo de la zona de comentarios del control del commit, cortado hasta su `fi` de primer nivel. */
function hookBlock() {
  const hook = fs.readFileSync(HOOK, 'utf8');
  const from = hook.indexOf('# ── La historia interna en los comentarios');
  assert.ok(from > 0, 'el control del commit tiene el tramo');
  return hook.slice(from, hook.indexOf('\nfi\n', from) + 4);
}
/** Corre el tramo en un repo de juguete. `guardCode`: si viene, el guion del freno de ese repo sale con ese código. */
function runHookBlock(l, { withGuard = true, guardCode = null } = {}) {
  if (withGuard) {
    // un guion de mentira en la ruta del freno, sin versionar: llama al freno de verdad, o sale con el código pedido
    const body = guardCode === null
      ? `const r = require('child_process').spawnSync(process.execPath, [${JSON.stringify(GUARD)}, ...process.argv.slice(2)], { stdio: 'inherit' }); process.exitCode = r.status;`
      : `process.stderr.write('no pude mirar\\n'); process.exitCode = ${guardCode};`;
    write(l.repo, { 'scripts/publishing/internal-history.js': body });
  }
  return spawnSync('bash', ['-c', `REPO_ROOT="$1"; cd "$REPO_ROOT" || exit 9\n${hookBlock()}\necho fin`, 'x', l.repo], {
    encoding: 'utf8', env: cleanEnv({ HOME: l.home, USERPROFILE: l.home, TYCON_INTERNAL_HISTORY: 'block' }),
  });
}

test('T20b CommentGuard_HookBlock_RejectsAndCannotLook — el tramo del control del commit frena de verdad', () => {
  const l = publicLab();
  stage(l.repo, { 'scripts/run.sh': `#!/usr/bin/env bash\n# Corre ${RED['batch-code']}.\necho ok\n` });
  const red = runHookBlock(l);
  assert.strictEqual(red.status, 1, `${red.stdout}${red.stderr}`);
  assert.match(red.stderr, /COMMIT RECHAZADO — historia interna en un comentario nuevo/);
  assert.match(red.stderr, /scripts\/run\.sh:2\s+batch-code/);
  const k = publicLab();
  stage(k.repo, { 'scripts/run.sh': '#!/usr/bin/env bash\n# Corre el lote.\necho ok\n' });
  assert.strictEqual(runHookBlock(k).status, 0, 'sin historia nueva sigue');
  const c = publicLab();
  stage(c.repo, { 'scripts/run.sh': '#!/usr/bin/env bash\n# Corre el lote.\necho ok\n' });
  const cannot = runHookBlock(c, { guardCode: 2 });
  assert.strictEqual(cannot.status, 1, '«no pude mirar» no es verde');
  assert.match(cannot.stderr, /no se pudo mirar/);
});

// ══ T21 · sólo el árbol que se publica ════════════════════════════════════════════════════════════════════════════

test('T21 CommentGuard_OnlyPublishedTree — en el repo del equipo no aplica; en un repo de producto no corre', () => {
  // el repo del equipo: el perfil ya está en la base
  const l = publicLab();
  stage(l.repo, { 'team-profile.json': { name: 'acme' } });
  commit(l.repo, 'perfil');
  stage(l.repo, { 'scripts/new.js': `// ${RED.date}\n` });
  const r = guard(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /no aplica/);
  const all = guard(l, { args: ['--all', '--json'] });
  assert.strictEqual(all.code, 0, all.out);
  assert.deepStrictEqual(JSON.parse(all.stdout), { zone: 'comment', applies: false });
  commit(l.repo, 'código');
  const range = guard(l, { args: ['--range', 'HEAD~1...HEAD'] });
  assert.strictEqual(range.code, 0, range.out);
  assert.match(range.out, /no aplica/);

  // con el otro nombre del perfil, también es el repo del equipo
  const alias = publicLab();
  stage(alias.repo, { 'perfil-equipo.json': { name: 'acme' } });
  commit(alias.repo, 'perfil');
  stage(alias.repo, { 'scripts/new.js': `// ${RED.date}\n` });
  assert.match(guard(alias).out, /no aplica/);
  // la base adelgazada, o con la lista ilegible, sí se mira; `A..B` toma la base de la izquierda; `--all --ref` mira esa punta
  for (const list of [{ layout: 'thin', own: {} }, '{ ilegible']) {
    const t = publicLab();
    stage(t.repo, { '.tycon/internal-forms.json': list });
    commit(t.repo, 'lista');
    stage(t.repo, { 'scripts/new.js': `// ${RED.date}\n` });
    assert.doesNotMatch(guard(t).out, /no aplica/, JSON.stringify(list));
  }
  const two = publicLab();
  const before = git(two.repo, ['rev-parse', 'HEAD']);
  stage(two.repo, { 'team-profile.json': { name: 'acme' }, 'scripts/new.js': `// ${RED.date}\n` });
  commit(two.repo, 'perfil y código');
  const dots = guard(two, { args: ['--range', `${before}..HEAD`] });
  assert.strictEqual(dots.code, 1, `la base es la del lado izquierdo: ${dots.out}`);
  assert.deepStrictEqual(JSON.parse(guard(two, { args: ['--all', '--json', '--ref', before] }).stdout).zone, 'comment', 'en la punta de antes, el público');
  assert.deepStrictEqual(JSON.parse(guard(two, { args: ['--all', '--json'] }).stdout), { zone: 'comment', applies: false }, 'en HEAD, el del equipo');
  // sin commits todavía, se mira el disco
  const empty = tmp('code-comments-empty');
  git(empty, ['init', '-q', '-b', 'main']);
  write(empty, { 'team-profile.json': { name: 'acme' }, 'scripts/new.js': `// ${RED.date}\n` });
  git(empty, ['add', '-A']);
  const e = spawnSync(process.execPath, [GUARD, '--repo', empty, '--zone', 'comment'], { cwd: empty, encoding: 'utf8', env: cleanEnv({ HOME: empty, TYCON_INTERNAL_HISTORY: 'block' }) });
  assert.match(`${e.stdout}${e.stderr}`, /no aplica/);

  // un pedido al público que agrega el perfil (o la lista del adelgazado) junto con historia no se apaga a sí mismo
  for (const extra of [{ 'team-profile.json': { name: 'acme' } }, { '.tycon/internal-forms.json': { layout: 'thin', own: {} } }]) {
    const p = publicLab();
    stage(p.repo, { ...extra, 'scripts/new.js': `// ${RED.date}\n` });
    const pr = guard(p);
    assert.strictEqual(pr.code, 1, `${Object.keys(extra)[0]}: ${pr.out}`);
    assert.doesNotMatch(pr.out, /no aplica/);
  }

  // el tramo del control del commit: sólo llama al freno si el repo trae su guion
  assert.match(hookBlock(), /INTERNAL_HISTORY="\$REPO_ROOT\/scripts\/publishing\/internal-history\.js"/);
  const p = publicLab();
  stage(p.repo, { 'src/app.js': `// ${RED.date}\n` });
  const run = runHookBlock(p, { withGuard: false });
  assert.strictEqual(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /fin/, 'un repo sin el guion del freno sigue de largo');
});

test('T23 CommentGuard_ThinOverlay_PrivateChangesStayPrivate — en el árbol armado del adelgazado, lo privado que cambia el commit no se publica', () => {
  // la punta del privado: la lista del adelgazado y un pipeline propio
  const l = publicLab();
  stage(l.repo, { '.tycon/internal-forms.json': { layout: 'thin', own: {} }, 'pipelines/private.yml': 'steps:\n  # Corre el lote.\n  - script: echo ok\n' });
  commit(l.repo, 'privado');
  // la superposición encima: trae un guion del público
  stage(l.repo, { 'scripts/public.js': '// Lo trae el público.\nmodule.exports = 1;\n' });
  commit(l.repo, 'arnés de GitHub [superposición local, no se empuja]');
  // el commit sobre el árbol armado cambia lo privado (y suma un archivo propio): eso no sale, no es del freno
  stage(l.repo, { 'pipelines/private.yml': `steps:\n  # Corre el lote ${RED['story-number']}.\n  - script: echo ok\n`, 'scripts/own-new.js': `// ${RED.date}\n` });
  const quiet = guard(l);
  assert.strictEqual(quiet.code, 0, `lo privado del commit se tomó como publicado: ${quiet.out}`);
  // lo que trajo el público sí se mira: cambiarlo con historia frena
  stage(l.repo, { 'scripts/public.js': `// Lo trae el público ${RED.date}.\nmodule.exports = 1;\n` });
  const red = guard(l);
  assert.strictEqual(red.code, 1, red.out);
  assert.match(red.out, /scripts\/public\.js:1/);
  assert.doesNotMatch(red.out, /pipelines\/private\.yml|scripts\/own-new\.js/);
});
