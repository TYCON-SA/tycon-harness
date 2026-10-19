'use strict';

/**
 * coverage-readers.test.js — la cobertura de pytest (Cobertura con <sources>), de Maven y Gradle (JaCoCo) y de Go
 * (el perfil de `go test`), leída a la misma forma que el lcov: ruta real del archivo → línea → veces ejecutada.
 *
 * Lo que sostiene: los tres lectores dan el mismo mapa para los mismos archivos, y un archivo que no se puede ubicar en
 * el disco queda nombrado aparte, nunca contado como cero.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readCobertura, readJacoco, readGoCover } = require(path.resolve(__dirname, '..', 'lib', 'coverage-readers.js'));

function proyecto() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'covread-')));
  fs.mkdirSync(path.join(d, 'app'), { recursive: true });
  fs.mkdirSync(path.join(d, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(d, 'app', 'util.py'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(d, 'lib', 'db.py'), 'a\nb\n');
  return d;
}
const lineas = (m) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, Object.fromEntries(v)]));

test('@story-8.48 @ac-13 T15 CoberturaSources_RelativePaths_Resolved', () => {
  const d = proyecto();
  const xml = path.join(d, 'coverage.xml');
  fs.writeFileSync(xml, `<?xml version="1.0" ?>
<coverage version="7.4" line-rate="0.5">
  <sources><source>${path.join(d, 'app')}</source><source>${path.join(d, 'lib')}</source></sources>
  <packages><package name="."><classes>
    <class name="util.py" filename="util.py" line-rate="0.66"><lines><line number="1" hits="1"/><line number="2" hits="0"/><line number="3" hits="2"/></lines></class>
    <class name="db.py" filename="db.py" line-rate="1"><lines><line number="1" hits="1"/><line number="2" hits="1"/></lines></class>
    <class name="fantasma.py" filename="fantasma.py" line-rate="0"><lines><line number="1" hits="0"/></lines></class>
  </classes></package></packages>
</coverage>`);
  const r = readCobertura(xml, { projectDir: d });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(lineas(r.map), {
    [path.join(d, 'app', 'util.py')]: { 1: 1, 2: 0, 3: 2 },
    [path.join(d, 'lib', 'db.py')]: { 1: 1, 2: 1 },
  });
  assert.deepEqual(r.unresolved, ['fantasma.py']);
});

test('@story-8.48 @ac-35 CoverageReaders_JacocoAndGo_SameMapAsCobertura', () => {
  const d = proyecto();
  const jacoco = path.join(d, 'jacoco.xml');
  fs.writeFileSync(jacoco, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">
<report name="demo"><package name="app">
  <sourcefile name="util.py"><line nr="1" mi="0" ci="2" mb="0" cb="0"/><line nr="2" mi="3" ci="0" mb="0" cb="0"/><line nr="3" mi="0" ci="1" mb="0" cb="0"/></sourcefile>
</package><package name="lib"><sourcefile name="db.py"><line nr="1" mi="0" ci="1"/><line nr="2" mi="0" ci="1"/></sourcefile></package>
<package name="nada"><sourcefile name="Fantasma.java"><line nr="1" mi="1" ci="0"/></sourcefile></package></report>`);
  const j = readJacoco(jacoco, { projectDir: d });
  assert.equal(j.ok, true, j.reason);
  const covered = (m) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, Object.fromEntries([...v].map(([n, h]) => [n, h > 0 ? 1 : 0]))]));
  const esperado = { [path.join(d, 'app', 'util.py')]: { 1: 1, 2: 0, 3: 1 }, [path.join(d, 'lib', 'db.py')]: { 1: 1, 2: 1 } };
  assert.deepEqual(covered(j.map), esperado);
  assert.deepEqual(j.unresolved, ['nada/Fantasma.java']);

  // Go: el perfil nombra cada archivo con la ruta del módulo; las líneas salen de los bloques start.col,end.col
  fs.writeFileSync(path.join(d, 'go.mod'), 'module acme.io/demo\n\ngo 1.22\n');
  const cover = path.join(d, 'cover.out');
  fs.writeFileSync(cover, ['mode: set',
    'acme.io/demo/app/util.py:1.1,1.5 1 1',
    'acme.io/demo/app/util.py:2.1,2.9 1 0',
    'acme.io/demo/app/util.py:3.1,3.4 1 1',
    'acme.io/demo/lib/db.py:1.1,2.3 2 1',
    'acme.io/demo/otra/fantasma.go:1.1,1.2 1 0', ''].join('\n'));
  const g = readGoCover(cover, { projectDir: d });
  assert.equal(g.ok, true, g.reason);
  assert.deepEqual(covered(g.map), esperado);
  assert.deepEqual(g.unresolved, ['otra/fantasma.go']);
});

test('@story-8.48 @ac-35 CoverageReaders_JacocoMultiModule_Located', () => {
  // un reporte agregado de Maven o Gradle con varios módulos: cada archivo está en <módulo>/src/main/java/<paquete>
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'covread-mm-')));
  fs.mkdirSync(path.join(d, 'mod1', 'src', 'main', 'java', 'a'), { recursive: true });
  fs.mkdirSync(path.join(d, 'mod2', 'src', 'main', 'kotlin', 'b'), { recursive: true });
  fs.writeFileSync(path.join(d, 'mod1', 'src', 'main', 'java', 'a', 'App.java'), 'x\n');
  fs.writeFileSync(path.join(d, 'mod2', 'src', 'main', 'kotlin', 'b', 'Db.kt'), 'x\n');
  const xml = path.join(d, 'jacoco.xml');
  fs.writeFileSync(xml, '<report name="agg"><package name="a"><sourcefile name="App.java"><line nr="1" mi="0" ci="1"/></sourcefile></package><package name="b"><sourcefile name="Db.kt"><line nr="1" mi="1" ci="0"/></sourcefile></package></report>');
  const r = readJacoco(xml, { projectDir: d });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual([...r.map.keys()].sort(), [path.join(d, 'mod1', 'src', 'main', 'java', 'a', 'App.java'), path.join(d, 'mod2', 'src', 'main', 'kotlin', 'b', 'Db.kt')]);
});

test('@story-8.48 @ac-13 CoverageReaders_PathsOutsideProject_NotOpened', () => {
  // el reporte lo escribe el repo probado: una ruta absoluta o con «..» que sale del proyecto no se abre
  const d = proyecto();
  const afuera = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'covread-afuera-')));
  fs.writeFileSync(path.join(afuera, 'secreto.py'), 'x\n');
  const xml = path.join(d, 'coverage.xml');
  fs.writeFileSync(xml, `<coverage><sources><source>${afuera}</source><source>${d}</source></sources><packages><package><classes>
    <class filename="${path.join(afuera, 'secreto.py')}"><lines><line number="1" hits="1"/></lines></class>
    <class filename="../${path.basename(afuera)}/secreto.py"><lines><line number="1" hits="1"/></lines></class>
    <class filename="secreto.py"><lines><line number="1" hits="1"/></lines></class>
    <class filename="app/util.py"><lines><line number="1" hits="1"/></lines></class>
  </classes></package></packages></coverage>`);
  const r = readCobertura(xml, { projectDir: d });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual([...r.map.keys()], [path.join(d, 'app', 'util.py')]);
  assert.equal(r.unresolved.length, 3);
  // si ningún archivo del reporte está en el proyecto, no es «cobertura cero»: es un reporte que no sirve
  const soloAfuera = path.join(d, 'afuera.xml');
  fs.writeFileSync(soloAfuera, `<coverage><packages><package><classes><class filename="/etc/hosts"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>`);
  const s = readCobertura(soloAfuera, { projectDir: d });
  assert.equal(s.ok, false);
  assert.match(s.reason, /ningún archivo del reporte está en el proyecto/);
});

test('@story-8.48 @ac-13 CoverageReaders_Unreadable_ReasonNotZero', () => {
  const d = proyecto();
  for (const fn of [readCobertura, readJacoco, readGoCover]) {
    const r = fn(path.join(d, 'no-existe'), { projectDir: d });
    assert.equal(r.ok, false);
    assert.ok(r.reason && r.reason.length > 0);
  }
  const roto = path.join(d, 'roto.xml');
  fs.writeFileSync(roto, '<coverage><packages>');
  assert.equal(readCobertura(roto, { projectDir: d }).ok, false);
  const gomal = path.join(d, 'mal.out');
  fs.writeFileSync(gomal, 'no es un perfil\n');
  assert.equal(readGoCover(gomal, { projectDir: d }).ok, false);
});
