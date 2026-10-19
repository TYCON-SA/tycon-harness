'use strict';

/**
 * junit-report.test.js — los totales de un reporte JUnit, el que dejan pytest, gotestsum, Maven, Gradle y Karma.
 *
 * Lo que sostiene: se cuentan los <testcase> (no los atributos del <testsuite>, que cada herramienta escribe distinto),
 * un <error> cuenta como falla, un <skipped> como salteada, y varios archivos se suman.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readJunit } = require(path.resolve(__dirname, '..', 'lib', 'junit-report.js'));

function escribir(dir, nombre, xml) {
  const f = path.join(dir, nombre);
  fs.writeFileSync(f, xml);
  return f;
}

test('@story-8.48 @ac-9 T10 JunitReport_Totals_PassFailSkipError', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'junit-'));
  // pytest: <testsuites><testsuite> con un caso fallado y uno salteado
  const pytest = escribir(d, 'pytest.xml', `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="4">
<testcase classname="tests.test_a" name="test_uno" time="0.01"/>
<testcase classname="tests.test_a" name="test_dos" time="0.01"><failure message="assert 1 == 2">x</failure></testcase>
<testcase classname="tests.test_a" name="test_tres" time="0"><skipped message="no"/></testcase>
<testcase classname="tests.test_a" name="test_cuatro" time="0.01"/>
</testsuite></testsuites>`);
  // gotestsum: varios <testsuite> sueltos dentro de <testsuites>, con un <error>
  const go = escribir(d, 'junit.xml', `<testsuites tests="3" failures="0" errors="1">
<testsuite tests="2" name="acme/svc"><testcase classname="acme/svc" name="TestA"/><testcase classname="acme/svc" name="TestB"><error message="panic">p</error></testcase></testsuite>
<testsuite tests="1" name="acme/db"><testcase classname="acme/db" name="TestC"/></testsuite>
</testsuites>`);
  // surefire (Maven): un <testsuite> raíz por clase, uno por archivo
  const sure1 = escribir(d, 'TEST-a.AppTest.xml', '<testsuite name="a.AppTest" tests="2" failures="0" errors="0" skipped="0"><testcase name="t1" classname="a.AppTest"/><testcase name="t2" classname="a.AppTest"/></testsuite>');
  const sure2 = escribir(d, 'TEST-a.DbTest.xml', '<testsuite name="a.DbTest" tests="1" skipped="1"><testcase name="t3" classname="a.DbTest"><skipped/></testcase></testsuite>');

  assert.deepEqual(pick(readJunit([pytest])), { total: 4, passed: 2, failed: 1, skipped: 1 });
  assert.deepEqual(pick(readJunit([go])), { total: 3, passed: 2, failed: 1, skipped: 0 });
  assert.deepEqual(pick(readJunit([sure1, sure2])), { total: 3, passed: 2, failed: 0, skipped: 1 });
  assert.equal(readJunit([sure1, sure2]).files, 2);
});

test('@story-8.48 @ac-10 JunitReport_NoFilesOrBroken_SaysWhy', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'junit-'));
  const r = readJunit([]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no hay reporte/);
  const roto = escribir(d, 'roto.xml', '<testsuite><testcase');
  const r2 = readJunit([roto]);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /roto\.xml/);
  // un reporte sin ningún caso es un reporte válido con cero pruebas (la puerta decide que no es verde)
  const vacio = escribir(d, 'vacio.xml', '<testsuites></testsuites>');
  assert.deepEqual(pick(readJunit([vacio])), { total: 0, passed: 0, failed: 0, skipped: 0 });
});

test('@story-8.48 @ac-9 JunitReport_WithNamespace_StillCounts', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'junit-'));
  const f = escribir(d, 'ns.xml', '<testsuites xmlns="urn:x:junit"><testsuite name="a"><testcase name="t1"/><testcase name="t2"><failure/></testcase></testsuite></testsuites>');
  assert.deepEqual(pick(readJunit([f])), { total: 2, passed: 1, failed: 1, skipped: 0 });
});

function pick(r) {
  assert.equal(r.ok, true, r.reason);
  return { total: r.total, passed: r.passed, failed: r.failed, skipped: r.skipped };
}
