'use strict';

/**
 * deprecated.test.js — el lector del código deprecado de un repo: la lista, la marca y lo que no se puede mirar.
 *
 * La lista vive en `.tycon/advisors.yaml` (clave `deprecated`) y se lee de lo COMMITEADO: el agente no se puede sacar
 * una entrada escribiendo el archivo. La marca en la cabecera de un archivo vale igual que una entrada. Lo que no se
 * puede mirar no clasifica nada y queda como `unknown-*` en gates.log. Al final, las regresiones del pase adversarial.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dep = require('../lib/deprecated.js');
const cs = require('../lib/config-source.js');

// fechas fijas y sin el mantenimiento automático de git: el mismo repo de juguete en cada corrida
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-10-22T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-22T12:00:00Z' };
function git(dir, ...args) { spawnSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { stdio: 'ignore', env: GIT_ENV }); }

/** Repo de juguete: `commiteado` va al commit; `carpeta` queda sin commitear; `archivos` se commitean. */
function repo({ commiteado, carpeta, archivos = {} } = {}) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deprec-')));
  fs.mkdirSync(path.join(d, '.tycon'), { recursive: true });
  git(d, 'init', '-q', '-b', 'main', '.');
  for (const [rel, txt] of Object.entries({ 'a.txt': 'x\n', ...archivos })) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), txt);
  }
  if (commiteado != null) fs.writeFileSync(path.join(d, '.tycon', 'advisors.yaml'), commiteado);
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base');
  if (carpeta !== undefined) fs.writeFileSync(path.join(d, '.tycon', 'advisors.yaml'), carpeta);
  cs.limpiarCache();
  return d;
}

function estado() { return fs.mkdtempSync(path.join(os.tmpdir(), 'deprec-estado-')); }
function gatesLog(dir) { try { return fs.readFileSync(path.join(dir, 'gates.log'), 'utf8'); } catch (_e) { return ''; } }

const LISTA = [
  'deprecated:',
  '  edit: block',
  '  paths:',
  '    - path: "src/legacy/**"',
  '      level: frozen',
  '      reason: "reemplazado por src/billing (2026-09)"',
  '      review_by: 2027-01-31',
  '',
].join('\n');

test('Deprecated_LeeLaListaCommiteada', () => {
  const d = repo({ commiteado: LISTA, archivos: { 'src/legacy/x.js': 'x\n' } });
  const c = dep.clasificar(d, path.join(d, 'src/legacy/x.js'), { stateDir: estado() });
  assert.equal(c.level, 'frozen');
  assert.equal(c.source, 'config');
  assert.equal(c.reason, 'reemplazado por src/billing (2026-09)');
  assert.equal(c.entry.path, 'src/legacy/**');
  assert.equal(dep.leerLista(d).edit, 'block');

  // La misma clave escrita sólo en la carpeta no cuenta: ni para agregar ni para sacar.
  const sinCommit = repo({ commiteado: null, carpeta: LISTA, archivos: { 'src/legacy/x.js': 'x\n' } });
  assert.equal(dep.clasificar(sinCommit, path.join(sinCommit, 'src/legacy/x.js'), { stateDir: estado() }), null);
  const sacada = repo({ commiteado: LISTA, carpeta: 'deprecated:\n  paths: []\n', archivos: { 'src/legacy/x.js': 'x\n' } });
  assert.equal(dep.clasificar(sacada, path.join(sacada, 'src/legacy/x.js'), { stateDir: estado() }).level, 'frozen');
});

test('Deprecated_EntradaMalEscrita_NoClasifica', () => {
  const yaml = [
    'deprecated:',
    '  paths:',
    '    - level: frozen',
    '      reason: "sin ruta"',
    '    - path: "src/viejo/**"',
    '      level: viejo',
    '      reason: "nivel que no existe"',
    '    - path: "src/otro/**"',
    '      level: dead',
    '',
  ].join('\n');
  const d = repo({ commiteado: yaml, archivos: { 'src/viejo/a.js': 'x\n', 'src/otro/b.js': 'x\n' } });
  assert.equal(dep.clasificar(d, path.join(d, 'src/viejo/a.js'), { stateDir: estado() }), null);
  assert.equal(dep.clasificar(d, path.join(d, 'src/otro/b.js'), { stateDir: estado() }), null);
  const { problems } = dep.leerLista(d);
  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => /path/.test(p.motivo)));
  assert.ok(problems.some((p) => /level/.test(p.motivo) && /viejo/.test(p.motivo)));
  assert.ok(problems.some((p) => /reason/.test(p.motivo)));
});

test('Deprecated_GlobYCarpeta', () => {
  const yaml = [
    'deprecated:',
    '  paths:',
    '    - path: "src/legacy/**"',
    '      level: frozen',
    '      reason: "uno"',
    '    - path: docs/old.md',
    '      level: dead',
    '      reason: "dos"',
    '    - path: "**/*.v1.ts"',
    '      level: frozen',
    '      reason: "tres"',
    '    - path: src/viejo',
    '      level: frozen',
    '      reason: "cuatro"',
    '',
  ].join('\n');
  const archivos = {
    'src/legacy/a/b.js': 'x\n',
    'docs/old.md': 'x\n',
    'docs/sub/old.md': 'x\n',
    'app/x.v1.ts': 'x\n',
    'app/x.v2.ts': 'x\n',
    'src/viejo/c.js': 'x\n',
    'src/viejos/d.js': 'x\n',
    'src/vivo.js': 'x\n',
    'src/legacy/marcado.js': '// harness-deprecated: dead — se borra en enero\nmodule.exports = 1;\n',
  };
  const d = repo({ commiteado: yaml, archivos });
  const lv = (rel) => { const c = dep.clasificar(d, path.join(d, rel), { stateDir: estado() }); return c && c.level; };
  assert.equal(lv('src/legacy/a/b.js'), 'frozen');
  assert.equal(lv('docs/old.md'), 'dead');
  assert.equal(lv('docs/sub/old.md'), null, 'una ruta sin comodines es relativa al repo, no un nombre suelto');
  assert.equal(lv('app/x.v1.ts'), 'frozen');
  assert.equal(lv('app/x.v2.ts'), null);
  assert.equal(lv('src/viejo/c.js'), 'frozen', 'una carpeta sin /** alcanza lo de adentro');
  assert.equal(lv('src/viejos/d.js'), null, 'el prefijo de otra carpeta no cuenta');
  assert.equal(lv('src/vivo.js'), null);
  const marcado = dep.clasificar(d, path.join(d, 'src/legacy/marcado.js'), { stateDir: estado() });
  assert.equal(marcado.level, 'dead', 'con dos niveles gana el más estricto');
  assert.equal(marcado.source, 'mark');
  assert.equal(marcado.reason, 'se borra en enero');
});

test('Deprecated_MarcaEnLaCabecera', () => {
  const relleno = (n) => Array.from({ length: n }, (_, i) => `linea ${i}`).join('\n') + '\n';
  const archivos = {
    'a.js': 'x\ny\n// harness-deprecated: frozen — a reemplazar\n',
    'b.py': '#!/usr/bin/env python\n\n# harness-deprecated: dead - no se usa\n',
    'c.html': '<html>\n\n<!-- harness-deprecated: frozen — vieja portada -->\n',
    'd.sql': '-- harness-deprecated: dead — esquema viejo\n',
    'e.css': '/* harness-deprecated: frozen — estilos v1 */\n',
    'lejos.js': relleno(29) + '// harness-deprecated: dead — muy abajo\n',
    'texto.js': 'const s = "harness-deprecated: dead — en un texto";\n',
  };
  const d = repo({ commiteado: null, archivos });
  const c = (rel) => dep.clasificar(d, path.join(d, rel), { stateDir: estado() });
  assert.deepEqual([c('a.js').level, c('a.js').reason], ['frozen', 'a reemplazar']);
  assert.deepEqual([c('b.py').level, c('b.py').reason], ['dead', 'no se usa']);
  assert.deepEqual([c('c.html').level, c('c.html').reason], ['frozen', 'vieja portada']);
  assert.equal(c('d.sql').level, 'dead');
  assert.deepEqual([c('e.css').level, c('e.css').reason], ['frozen', 'estilos v1']);
  assert.equal(c('lejos.js'), null, 'más abajo de la línea 10 no cuenta');
  assert.equal(c('texto.js'), null, 'dentro de un texto no cuenta');
});

test('Deprecated_NoSePuedeMirar_NoClasifica', () => {
  // YAML ilegible: el bloque existe pero no tiene la forma que se puede leer.
  const ilegible = 'deprecated:\n  paths:\n\t- path: src/legacy/**\n  ??? esto no es yaml\n';
  const d = repo({ commiteado: ilegible, archivos: { 'src/legacy/x.js': 'x\n' } });
  const e1 = estado();
  assert.equal(dep.clasificar(d, path.join(d, 'src/legacy/x.js'), { stateDir: e1 }), null);
  assert.match(gatesLog(e1), /"status":"unknown-config-ilegible"/);

  // Carpeta sin git: no hay lista que leer, y queda dicho.
  const sinGit = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deprec-sin-git-')));
  fs.mkdirSync(path.join(sinGit, '.tycon'));
  fs.writeFileSync(path.join(sinGit, '.tycon', 'advisors.yaml'), LISTA);
  fs.mkdirSync(path.join(sinGit, 'src', 'legacy'), { recursive: true });
  fs.writeFileSync(path.join(sinGit, 'src', 'legacy', 'x.js'), 'x\n');
  cs.limpiarCache();
  const e2 = estado();
  assert.equal(dep.clasificar(sinGit, path.join(sinGit, 'src/legacy/x.js'), { stateDir: e2 }), null);
  assert.match(gatesLog(e2), /"status":"unknown-sin-git"/);
});

test('Deprecated_BordesDeLosGlobs', () => {
  const yaml = [
    'deprecated:',
    '  paths:',
    '    - path: src/viejo/',
    '      level: frozen',
    '      reason: "carpeta con barra final"',
    '    - path: "src/v?.js"',   // `matchGlob` no conoce `?`: es un caracter más, como en la superficie de los revisores
    '      level: frozen',
    '      reason: "un signo literal"',
    '    - path: "src/{a,b}.old.js"',
    '      level: frozen',
    '      reason: "alternativa"',
    '    - path: "src/doble/**"',
    '      level: frozen',
    '      reason: "uno"',
    '    - path: src/doble/x.js',
    '      level: dead',
    '      reason: "dos"',
  ].join('\n') + '\n';
  const d = repo({ commiteado: yaml, archivos: { 'src/viejo/a.js': 'x\n', 'src/v?.js': 'x\n', 'src/v1.js': 'x\n', 'src/a.old.js': 'x\n', 'src/c.old.js': 'x\n', 'src/doble/x.js': 'x\n' } });
  const lv = (rel) => { const c = dep.clasificar(d, path.join(d, rel), { stateDir: estado() }); return c && c.level; };
  assert.equal(lv('src/viejo/a.js'), 'frozen');
  assert.equal(lv('src/v?.js'), 'frozen');
  assert.equal(lv('src/v1.js'), null);
  assert.equal(lv('src/a.old.js'), 'frozen');
  assert.equal(lv('src/c.old.js'), null);
  assert.equal(lv('src/doble/x.js'), 'dead', 'dos entradas de la lista con distinto nivel: gana la más estricta');
});

// ── Regresiones del lector: config de git, nombres raros, entradas, frontmatter y enlaces───────────────────────────────────────────────────────────

test('Adversarial_LineasAgregadas_NoDependeDeLaConfigDeGit', () => {
  const yaml = 'deprecated:\n  paths:\n    - path: "src/legacy/**"\n      level: frozen\n      reason: "r"\n';
  const archivos = { 'src/legacy/a.js': 'x\n', 'src/vivo/b.js': 'x\n', 'src/vivo/señal.js': 'x\n', 'src/vivo/con espacio.js': 'x\n' };
  for (const conf of [[], ['diff.mnemonicPrefix', 'true'], ['diff.noprefix', 'true']]) {
    const d = repo({ commiteado: yaml, archivos });
    if (conf.length) spawnSync('git', ['-C', d, 'config', ...conf]);
    for (const f of ['src/vivo/b.js', 'src/vivo/señal.js', 'src/vivo/con espacio.js']) fs.appendFileSync(path.join(d, f), "require('../legacy/a');\n");
    fs.writeFileSync(path.join(d, 'src/vivo/año.js'), "require('../legacy/a');\n");
    const archivosConAviso = dep.vivoQueNombraDeprecado({ repo: d, stateDir: estado() }).map((h) => h.file).sort();
    assert.deepEqual(archivosConAviso, ['src/vivo/año.js', 'src/vivo/b.js', 'src/vivo/con espacio.js', 'src/vivo/señal.js'], `config ${conf.join('=')}`);
    const acotado = dep.vivoQueNombraDeprecado({ repo: d, files: ['src/vivo/con espacio.js'], stateDir: estado() });
    assert.equal(acotado.length, 1, 'un nombre con espacio se acota igual');
  }
});

test('Adversarial_LineasAgregadas_DiffDeMasDeUnMega', () => {
  const yaml = 'deprecated:\n  paths:\n    - path: "src/legacy/**"\n      level: frozen\n      reason: "r"\n';
  const d = repo({ commiteado: yaml, archivos: { 'src/legacy/a.js': 'x\n', 'src/vivo/grande.js': 'x\n' } });
  fs.appendFileSync(path.join(d, 'src/vivo/grande.js'), `${'// relleno\n'.repeat(150000)}require('../legacy/a');\n`);
  assert.equal(dep.vivoQueNombraDeprecado({ repo: d, stateDir: estado() }).length, 1);
});

test('Adversarial_DEPR-W1_EntradaMasEstricta_MarcaYConfiguracion', () => {
  const yaml = 'deprecated:\n  paths:\n    - path: "src/**"\n      level: frozen\n      reason: "amplia"\n    - path: src/viejo\n      level: dead\n      reason: "muerta"\n';
  const d = repo({ commiteado: yaml, archivos: { 'src/viejo/a.js': 'x\n', 'lib/vivo.js': 'x\n', 'lib/marcado.js': '// harness-deprecated: dead — por la marca\n' } });
  fs.appendFileSync(path.join(d, 'lib/vivo.js'), "require('../src/viejo/a');\nrequire('./marcado');\n");
  fs.mkdirSync(path.join(d, '.tycon'), { recursive: true });
  fs.appendFileSync(path.join(d, '.tycon/advisors.yaml'), '    - path: "src/otro/**"\n      level: frozen\n      reason: "nueva"\n');
  const h = dep.vivoQueNombraDeprecado({ repo: d, stateDir: estado() });
  assert.deepEqual(h.map((x) => [x.file, x.line, x.entrada]).sort(), [['lib/vivo.js', 2, 'src/viejo'], ['lib/vivo.js', 3, 'lib/marcado.js']]);
  assert.match(h.find((x) => x.line === 2).detail, /dead: muerta/);
});

test('Adversarial_Entradas_BarraInicialGlobRotoYComillasConNumeral', () => {
  const yaml = [
    'deprecated:', '  paths:',
    '    - path: /src/x', '      level: frozen', '      reason: "barra"',
    '    - path: "src/{*a,b}.js"', '      level: frozen', '      reason: "llave que empieza con asterisco"',
    '    - path: src/y', '      level: frozen', '      reason: "reemplazado por el #42 del tablero"   # comentario',
  ].join('\n') + '\n';
  const d = repo({ commiteado: yaml, archivos: { 'src/y/a.js': 'x\n' } });
  const l = dep.leerLista(d);
  assert.equal(l.entries.length, 1);
  assert.equal(l.entries[0].reason, 'reemplazado por el #42 del tablero');
  assert.equal(l.problems.length, 2);
  assert.ok(l.problems.some((p) => /sin `\/`/.test(p.motivo)));
  assert.ok(l.problems.some((p) => /glob/.test(p.motivo)));
  assert.equal(dep.clasificar(d, path.join(d, 'src/y/a.js'), { stateDir: estado() }).reason, 'reemplazado por el #42 del tablero');
});

test('Adversarial_Frontmatter_ComentariosCorchetesComillasYMotivoVacio', () => {
  const t = (cuerpo) => `---\nstory: "1.1"\n${cuerpo}\n---\n`;
  assert.deepEqual(dep.listaDelFrontmatter(t('files_to_modify:\n  - a.js\n# privado\n  - b.js'), 'files_to_modify'), ['a.js', 'b.js']);
  assert.deepEqual(dep.listaDelFrontmatter(t('files_to_modify: [a.js, "c.js"]'), 'files_to_modify'), ['a.js', 'c.js']);
  assert.deepEqual(dep.entradasDelFrontmatter(t('files_to_modify:\n  - "(otro) x.js"'), 'files_to_modify'), [{ ruta: 'x.js', repo: 'otro' }]);
  for (const v of ['', '~', 'null', '# nada', '"" ']) assert.equal(dep.motivoDeLaHistoria(t(`deprecated_reason: ${v}`)), '', `«${v}»`);
  assert.equal(dep.motivoDeLaHistoria(t('deprecated_reason: arreglo  # por qué')), 'arreglo');
});

test('Adversarial_Rutas_EnlaceYMayusculas', () => {
  const yaml = 'deprecated:\n  paths:\n    - path: "src/legacy/**"\n      level: frozen\n      reason: "r"\n';
  const d = repo({ commiteado: yaml, archivos: { 'src/legacy/a.js': 'x\n' } });
  const enlace = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deprec-enlace-')), 'repo');
  fs.symlinkSync(d, enlace);
  assert.equal(dep.clasificar(d, path.join(enlace, 'src/legacy/nueva/carpeta/x.js'), { stateDir: estado() }).level, 'frozen', 'una ruta nueva por el enlace');
  const mayus = path.join(d, 'SRC/Legacy/A.js');
  if (fs.existsSync(mayus)) {   // sólo en un disco que no distingue mayúsculas (macOS, Windows)
    assert.equal(dep.clasificar(d, mayus, { stateDir: estado() }).level, 'frozen', 'el mismo archivo escrito con otras letras');
  }
});
