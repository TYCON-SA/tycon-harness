#!/usr/bin/env node
/**
 * e2e-evidence.js — pieza ÚNICA del contrato de evidencia del gate E2E.
 *
 * Por qué existe: el contrato (qué campos tiene que traer la evidencia para que
 * runtime-matrix.js la lea) se cumple copiando código en el gate de cada repo, y una copia
 * que se desvía bloquea por un detalle del script, no por la calidad de los tests.
 *
 * Dos usos, para que el contrato no dependa de que alguien copie bien:
 *   1) PRODUCIR — `titles <playwright.json>`: imprime los títulos de los tests que PASARON,
 *      uno por línea con "- ". Lo llaman el gate genérico del harness y los gates propios
 *      de los repos (que mantienen el suyo por razones legítimas, p.ej. levantar servers).
 *   2) VERIFICAR — `verify <evidencia.md>`: dice si una evidencia cumple el contrato y qué
 *      le falta. Sirve para chequear a CUALQUIER gate, sea del harness o del repo.
 *   3) CAPTURAS — `captures <playwright.json> <carpeta>`: copia las imágenes y las grabaciones (.webm)
 *      adjuntas de la corrida a la evidencia y las lista; el cierre se las muestra al dev antes de pedir el commit.
 *      Deja además `captures.json` en la carpeta: de qué test y de qué criterio (`@ac-N` del título) vino cada una, con
 *      la huella de cada archivo, y sella el índice en el gates.log del home (fuera del repo): es lo que la matriz lee
 *      para dar por visto un criterio de pantalla, y sólo lo cuenta si el sello y las huellas coinciden.
 *
 * Exit de `verify`: 0 cumple · 1 le falta algo (lista los campos) · 2 error de uso.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const captureFile = require('./capture-file.js');
const { stateDir } = require('./state-dir.js');

// Lo que el portón guarda como captura o grabación: las imágenes de Playwright y su video.
const CAPTURE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm'];

/** Títulos de los tests que PASARON en un reporter JSON de Playwright. */
function passedTitles(reportJson) {
  const out = [];
  const walk = (suites) => (suites || []).forEach((s) => {
    (s.specs || []).forEach((sp) => (sp.tests || []).forEach((t) => {
      const st = (t.results || []).length ? t.results[t.results.length - 1].status : 'failed';
      if (st === 'passed') out.push(sp.title || '');
    }));
    walk(s.suites);
  });
  try { walk(reportJson.suites); } catch { /* json roto → sin títulos */ }
  return out;
}

/** Totales, con `skipped` contado aparte (contarlo como failed daría evidencia contradictoria). */
function totals(reportJson) {
  const t = { total: 0, passed: 0, failed: 0, skipped: 0 };
  const walk = (suites) => (suites || []).forEach((s) => {
    (s.specs || []).forEach((sp) => (sp.tests || []).forEach((x) => {
      t.total++;
      const st = (x.results || []).length ? x.results[x.results.length - 1].status : 'failed';
      if (st === 'passed') t.passed++;
      else if (st === 'skipped') t.skipped++;
      else t.failed++;
    }));
    walk(s.suites);
  });
  try { walk(reportJson.suites); } catch { /* json roto → 0s; el exit code manda */ }
  return t;
}

/**
 * Veredicto del gate — TRES estados, no dos.
 *
 * 🔴 Por qué no alcanza el exit code de Playwright: Playwright devuelve **0 cuando todos los tests
 * se saltean**. Con una base sin datos, el gate podría reportar `PASS (0/4)`: verde, exit 0, merge
 * habilitado, y CERO flujos ejercidos. Eso es peor que un rojo: un rojo se discute, un verde hueco
 * se firma sin mirar.
 *
 * La regla: si Playwright falló, manda el rojo (`FAIL`). Si no falló pero **no ejecutó ni un test**,
 * el gate NO puede decir que pasó: `SIN_EJERCER`, con exit != 0. Alcanza con UN test ejecutado para
 * que un verde sea legítimo — saltear algunos es normal y está declarado en los specs.
 *
 * 🔴 Los códigos de salida NO son libres: el contrato del paso «Probar en vivo» (`steps/step-10-live-check.md`)
 * le da significado a cada uno, y el orquestador ACTÚA según el número. `SIN_EJERCER` no usa
 * exit 3: 3 significa «el stack no levantó», y el remedio que ese código manda a
 * hacer es levantar servicios que están perfectamente arriba, re-correr, y sacar 3 otra vez. Un
 * veredicto que manda a mirar donde no está el problema es el defecto que este veredicto
 * existe para cerrar. El mapa, y el único lugar donde se decide:
 *   1 → falló (lo que devuelva Playwright)      3 → el stack no levantó (precondición)
 *   2 → el filtro no matcheó ningún test        4 → había tests y TODOS se saltearon solos
 * 2 y 4 se separan porque la acción difiere: 2 es un nombre de spec mal escrito (se arregla el
 * filtro), 4 es un entorno sin los datos que los specs necesitan (se siembran los datos).
 */
function veredicto({ exitCode = 0, total = 0, passed = 0, failed = 0, skipped = 0 } = {}) {
  if (exitCode !== 0) {
    return { verdict: 'FAIL', exit: exitCode, motivo: `Playwright terminó con exit ${exitCode} (${failed} fallado/s)` };
  }
  const ejecutados = passed + failed;
  if (ejecutados === 0) {
    // Exit != 0 siempre (no ejerció ⇒ no pasa), y != 1 para distinguir "no ejerció" de "falló":
    // son dos acciones distintas para quien lee. Ver el mapa de códigos arriba.
    return total === 0
      ? { verdict: 'SIN_EJERCER', exit: 2, motivo: 'no se ejecutó ningún test: el filtro no matcheó nada' }
      : { verdict: 'SIN_EJERCER', exit: 4, motivo: `no se ejecutó ningún test: los ${skipped} del alcance se saltearon solos` };
  }
  return { verdict: 'PASS', exit: 0, motivo: `${passed} de ${ejecutados} ejecutado/s en verde` };
}

/**
 * Los filtros declarados que la app NO tiene.
 *
 * 🔴 Un set crítico que declara 5 recorridos puede hacer que el gate corra sobre
 * un solo spec y dar una línea final idéntica a la de una corrida completa. Un
 * control que no dice qué parte de su alcance no encontró no se puede auditar: "0/4" se lee como
 * "casi todo" cuando en realidad fue un quinto.
 *
 * Devuelve [] si no hay carpeta de specs: ahí no se puede saber, y afirmar que faltan todos sería
 * peor que callar.
 */
function filtrosNoEncontrados(frontendDir, filtros) {
  const dir = path.join(frontendDir, 'tests', 'e2e');
  let archivos;
  try { archivos = fs.readdirSync(dir); } catch { return []; }
  if (!archivos.length) return [];
  return (filtros || []).filter((f) => {
    // El filtro puede venir como nombre suelto o como ruta: se compara por el basename sin sufijo.
    const base = path.basename(String(f)).replace(/\.spec\.[tj]sx?$/, '');
    return !archivos.some((a) => a.startsWith(base));
  });
}

/**
 * Las pruebas apagadas que anota una constancia, o null si no lo dice. Los gates las escriben de tres formas:
 * `- skipped: N` (el del arnés), `skipped: N` (línea suelta) y `skipped=N` dentro de otra línea. Sin la línea no se
 * supone un cero: la matriz la trata como «no informado» y no da la evidencia por completa.
 * Se lee sólo la cabecera, hasta la salida pegada o los títulos: ahí abajo un «skipped=0» es texto de Playwright o de un
 * test, no lo que el gate contó.
 */
function skippedOf(texto) {
  const cabecera = String(texto || '').split(/^##\s+(?:Salida|Tests corridos)/m)[0];
  const m = cabecera.match(/(?:^|[\s(])skipped\s*[:=]\s*(\d+)/m);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Contrato de la evidencia. Cada entrada dice qué se busca y por qué hace falta —
 * el "por qué" viaja con la validación para que el mensaje de error sea accionable.
 */
const CONTRATO = [
  { id: 'verdict', re: /^verdict=(PASS|FAIL|SIN_EJERCER)$/m,
    que: 'línea `verdict=PASS|FAIL|SIN_EJERCER`',
    porque: 'es lo que runtime-matrix.js lee para saber si el gate pasó' },
  { id: 'spec_filter', re: /^\*\*Spec filter\*\*:/m,
    que: 'línea `**Spec filter**: <archivo|vacío>`',
    porque: 'ata la evidencia al spec corrido; sin eso no se puede atribuir a los tests de la story' },
  { id: 'tests_corridos', re: /^##\s+Tests corridos/m,
    que: 'sección `## Tests corridos` con los títulos de los tests que pasaron (uno por línea, con "- ")',
    porque: 'sin los títulos no se distingue un test que APRETÓ el botón (marca @mutates) de uno que sólo lo miró — regla DODRT-C8' },
];

function verify(texto) {
  const faltantes = CONTRATO.filter((c) => !c.re.test(texto));
  // La sección puede existir vacía: eso también rompe el contrato de forma silenciosa.
  const sec = texto.split(/^##\s+Tests corridos[^\n]*$/m)[1];
  const sinTitulos = sec !== undefined && !/^\s*-\s+\S/m.test(sec.split(/^##\s/m)[0] || '');
  return { ok: faltantes.length === 0 && !sinTitulos, faltantes, sinTitulos };
}

/**
 * Los criterios que el título de un test nombra con `@ac-N` (pueden ser varios: `@ac-2 @ac-3`). Se mira sólo el título del
 * test, no el del `describe` ni el de la suite: el criterio lo declara el test que lo ejerce.
 */
function acTags(title) {
  const out = new Set();
  for (const m of String(title || '').matchAll(/@ac-(\d+)\b/g)) out.add(parseInt(m[1], 10));
  return [...out].sort((a, b) => a - b);
}

/**
 * Las capturas de una corrida: los adjuntos de imagen del reporte JSON de Playwright — la captura que
 * `screenshot: 'on'` deja al terminar cada test y las que el spec adjunta por su cuenta con `testInfo.attach` — y las
 * grabaciones de video (`video/webm`). Devuelve [{ title, name, path, acs }] en el orden del reporte; `acs` son los
 * criterios que nombra el título del test, y sólo si el intento que sacó la imagen PASÓ: la captura de un intento
 * fallido (aunque el reintento pase) o de un test salteado se copia, pero no se ata a ningún criterio. Un trace o un
 * adjunto sin archivo no cuentan.
 */
function imageAttachments(reportJson) {
  const out = [];
  const walk = (suites) => (suites || []).forEach((s) => {
    (s.specs || []).forEach((sp) => (sp.tests || []).forEach((t) => (t.results || []).forEach((r) => {
      for (const a of r.attachments || []) {
        if (a && a.path && /^(image\/|video\/webm$)/.test(a.contentType || '')) {
          out.push({ title: sp.title || '', name: a.name || '', path: a.path, acs: r.status === 'passed' ? acTags(sp.title) : [] });
        }
      }
    })));
    walk(s.suites);
  });
  try { walk(reportJson.suites); } catch { /* json roto → sin capturas */ }
  return out;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Copia las capturas a `destDir` como `NN-<test>.<ext>`. Devuelve { copied, missing, index }: una imagen que el reporte
 * nombra y no está (o que no se pudo copiar, o que no sirve: enlace simbólico, extensión o primeros bytes que no son de
 * una imagen, más de 50 MB) se DEVUELVE con su motivo — callada, saldría como «ningún test corrió».
 * `index` es lo que va a `captures.json`: [{ file, title, acs, sha256 }], con `file` relativo a `destDir`.
 */
function copyCaptures(reportJson, destDir) {
  const slug = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'test';
  const copied = []; const missing = []; const index = [];
  for (const a of imageAttachments(reportJson)) {
    if (!fs.existsSync(a.path)) { missing.push({ path: a.path, motivo: 'no está en el disco' }); continue; }
    const motivo = captureFile.problem(a.path, CAPTURE_EXTS);
    if (motivo) { missing.push({ path: a.path, motivo }); continue; }
    try {
      fs.mkdirSync(destDir, { recursive: true });
      const n = String(copied.length + 1).padStart(2, '0');
      const file = `${n}-${slug(a.title)}.${captureFile.extOf(a.path)}`;
      fs.copyFileSync(a.path, path.join(destDir, file));
      copied.push(path.join(destDir, file));
      index.push({ file, title: a.title, acs: a.acs, sha256: sha256(fs.readFileSync(path.join(destDir, file))) });
    } catch (e) { missing.push({ path: a.path, motivo: `no se pudo copiar: ${e.code || e.message}` }); }
  }
  return { copied, missing, index };
}

/**
 * Escribe `captures.json` en `destDir` y sella su huella en el gates.log del home (el espejo que ya lee la matriz, fuera
 * del repo): una línea `e2e-captures` con la carpeta y el sha256 del índice. Sin la línea, el índice no cuenta. Devuelve
 * el texto de lo que no pudo (o null).
 */
function sealCaptures(index, destDir, home) {
  const text = JSON.stringify(index, null, 2) + '\n';
  try { fs.writeFileSync(path.join(destDir, 'captures.json'), text); } catch (e) {
    return `no se escribió captures.json (${e.code || e.message}): la matriz no sabrá de qué criterio es cada imagen`;
  }
  try {
    const dir = stateDir(home || os.homedir());
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'gates.log'), JSON.stringify({
      type: 'e2e-captures', ts: new Date().toISOString(), folder: path.basename(destDir), sha256: sha256(text),
    }) + '\n');
  } catch (e) {
    return `no se selló captures.json en el gates.log (${e.code || e.message}): la matriz no lo va a contar`;
  }
  return null;
}

module.exports = { passedTitles, totals, veredicto, skippedOf, filtrosNoEncontrados, verify, imageAttachments, copyCaptures, sealCaptures, CONTRATO };

if (require.main === module) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === 'titles') {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* sin títulos */ }
    console.log(passedTitles(j).map((t) => `- ${t}`).join('\n'));
    process.exit(0);
  }
  if (cmd === 'captures') {
    // `captures <playwright.json> <carpeta>`: copia las capturas y las imprime, una por línea («- <ruta>»).
    const dest = process.argv[4];
    if (!dest) { console.error('uso: e2e-evidence.js captures <playwright.json> <carpeta-destino>'); process.exit(2); }
    // Lo que no se pudo va a stderr, una línea por imagen: el gate lo escribe en `## Capturas`.
    let j = {};
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      console.error(`el reporte de Playwright no se pudo leer (${e.code || e.message}): no hay de dónde sacar capturas`);
    }
    // Un JSON que se lee pero no trae `suites` no es «ningún test corrió»: es otra forma de reporte.
    if (j && Object.keys(j).length && !Array.isArray(j.suites)) console.error('el reporte de Playwright no tiene la forma esperada (sin `suites`): no hay de dónde sacar capturas');
    const { copied, missing, index } = copyCaptures(j, dest);
    if (copied.length) console.log(copied.map((c) => `- ${c}`).join('\n'));
    // El índice no cambia el listado ni el veredicto: si no se puede escribir o sellar, las imágenes quedan y la matriz no las ata.
    if (index.length) {
      const falla = sealCaptures(index, dest);
      if (falla) console.error(falla);
    }
    for (const m of missing) console.error(`no se copió ${m.path}: ${m.motivo}`);
    process.exit(0);
  }
  if (cmd === 'verify') {
    let texto = '';
    try { texto = fs.readFileSync(file, 'utf8'); } catch (e) {
      console.error(`no pude leer la evidencia: ${e.message}`); process.exit(2);
    }
    const r = verify(texto);
    if (r.ok) { console.log(`✅ la evidencia cumple el contrato del gate E2E: ${file}`); process.exit(0); }
    console.error(`🔴 la evidencia NO cumple el contrato del gate E2E (${file}):`);
    for (const f of r.faltantes) console.error(`   - falta ${f.que}\n     → ${f.porque}`);
    if (r.sinTitulos) {
      console.error('   - la sección "## Tests corridos" está VACÍA');
      console.error('     → el gate la escribe pero no puso los títulos: usar `e2e-evidence.js titles <playwright.json>`');
    }
    console.error('\n   El gate genérico del harness ya cumple el contrato: si tu repo no necesita');
    console.error('   levantar servicios propios, sacá `e2e.gate` de .tycon/advisors.yaml y usalo.');
    process.exit(1);
  }
  console.error('uso: e2e-evidence.js titles <playwright.json> | captures <playwright.json> <carpeta> | verify <evidencia.md>');
  process.exit(2);
}
