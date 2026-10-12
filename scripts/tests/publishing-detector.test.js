'use strict';

/**
 * publishing-detector.test.js — el detector de lo que no puede salir (épica 8, story 8.1, 2026-09-26).
 *
 * Lo que no se puede perder, en orden de gravedad:
 *   · Que NUNCA dé «limpio» cuando no pudo mirar: sin config, config rota, excepción sin motivo,
 *     ruta inexistente, binario sin leer. Esa es la mentira más barata de un control así.
 *   · Que no imprima un secreto entero: el informe se pega en chats y PRs.
 *   · Que los términos cortos (un nombre que en minúscula es una palabra de todos los días) no disparen con ella.
 *
 * Usa sólo configs sintéticas: la lista real (scripts/publishing/denylist.json) es privada y
 * cambia; este test prueba el mecanismo, no la lista.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DETECTOR = path.join(__dirname, '..', 'publishing', 'detector.js');

function sandbox(archivos, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-'));
  for (const [rel, contenido] of Object.entries(archivos)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contenido);
  }
  const cfgPath = path.join(dir, 'denylist.json');
  if (config !== undefined) fs.writeFileSync(cfgPath, typeof config === 'string' ? config : JSON.stringify(config));
  return { dir, cfgPath };
}

function correr(args, cwd) {
  const r = spawnSync(process.execPath, [DETECTOR, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function correrJson(dir, cfgPath, rutas = [dir]) {
  const r = correr(['--config', cfgPath, '--base', dir, '--json', ...rutas], dir);
  return { code: r.code, json: r.out ? JSON.parse(r.out) : null, err: r.err };
}

const CFG = {
  terminos: [
    { patron: 'Acmecorp', categoria: 'cliente' },
    { patron: 'SOL', categoria: 'cliente', palabra: true, mayusculas: true },
    { patron: 'Pepe', categoria: 'persona', palabra: true },
  ],
};

test('Limpio_SinHallazgos_Exit0', () => {
  const { dir, cfgPath } = sandbox({ 'a.md': 'Una guía genérica sobre revisores.\n' }, CFG);
  const r = correrJson(dir, cfgPath);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.json.hallazgos.length, 0);
  assert.strictEqual(r.json.archivos, 1, 'mira el archivo y NO se cuenta a sí mismo (denylist.json)');
  assert.strictEqual(r.json.excluidos, 1);
});

test('Cliente_SubcadenaSinDistinguirMayusculas_Hallazgo', () => {
  const { dir, cfgPath } = sandbox({ 'a.md': 'ver el repo AcmecorpBackend\nhost acmecorp-api\n' }, CFG);
  const r = correrJson(dir, cfgPath);
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(r.json.hallazgos.map((h) => h.linea), [1, 2]);
  assert.strictEqual(r.json.porCategoria.cliente, 2);
});

test('TerminoCorto_PalabraYMayusculas_NoDisparaConLaPalabraComun', () => {
  const { dir, cfgPath } = sandbox({ 'a.md': 'hay que tomar sol\nSOLAR no es\nel plugin de SOL falló\n' }, CFG);
  const r = correrJson(dir, cfgPath);
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(r.json.hallazgos.map((h) => h.linea), [3], 'sólo SOL como palabra, en mayúsculas');
});

test('Secretos_SeDetectanYSalenEnmascarados', () => {
  // Armados por partes (story 8.8, AC 3): este archivo sale en la copia pública y el escaneo de secretos de GitHub no
  // lee las excepciones del equipo. Ninguna línea trae la forma entera; el detector recibe el texto de siempre.
  const secretos = [
    'https://x.blob.core.windows.net/c?sv=2022&sig=' + 'AbCdEfGhIjKlMnOpQrStUv%3D',
    `token ghp_${'a1B2'.repeat(9)}`,
    `key sk-ant-${'x'.repeat(30)}`,
    `bot 123456789:${'A'.repeat(35)}`,
    '-----BEGIN RSA PRIVATE ' + 'KEY-----',
    'Server=db;User ID=sa;Password=SuperSecreta123;',
    'PROVEEDOR_API_KEY=0123456789abcdef0123',
  ];
  const { dir, cfgPath } = sandbox({ 'cfg.txt': `${secretos.join('\n')}\n` }, CFG);
  const r = correr(['--config', cfgPath, '--base', dir, '--detail', dir], dir);
  assert.strictEqual(r.code, 1);
  const lineasSecreto = r.out.split('\n').filter((l) => l.includes('[secreto/'));
  assert.strictEqual(lineasSecreto.length, secretos.length, `uno por secreto:\n${r.out}`);
  for (const valor of ['AbCdEfGhIjKlMnOpQrStUv', 'a1B2a1B2a1B2', 'xxxxxxxxxxxxxxxxxxxx', 'AAAAAAAAAAAAAAAAAAAA', 'SuperSecreta123', '0123456789abcdef0123']) {
    assert.ok(!r.out.includes(valor), `el informe no puede mostrar «${valor}» entero`);
  }
});

test('RutaDeMaquina_PersonaSiPlaceholderNo', () => {
  const { dir, cfgPath } = sandbox({
    'a.md': 'cd /Users/juanp/SourceCode/x\nln -s /Users/<tu-usuario>/.claude\n/home/maria/repo\n',
  }, CFG);
  const r = correrJson(dir, cfgPath);
  assert.deepStrictEqual(r.json.hallazgos.filter((h) => h.categoria === 'ruta-de-maquina').map((h) => h.linea), [1, 3]);
});

test('Email_PersonaSiEjemploYServicioNo', () => {
  const { dir, cfgPath } = sandbox({
    'a.md': 'avisar a juana@empresa.com.ar\nusar dev@example.com\ngit@github.com:org/repo\nCo-Authored-By: X <noreply@anthropic.com>\nicono@2x.png\nprueba@ejemplo.invalid\n',
  }, CFG);
  const r = correrJson(dir, cfgPath);
  assert.deepStrictEqual(r.json.hallazgos.filter((h) => h.categoria === 'email').map((h) => h.texto), ['juana@empresa.com.ar']);
});

test('Email_ElNoreplyDeGithubNoEsElCorreoDeNadie_UnoQueSoloSeLeParece_Si', () => {
  // con el arnés mantenido en su repo público se firma con el `noreply` que GitHub le da a cada cuenta, y todo merge
  // hecho en su web lo firma `noreply@github.com`: si el detector los contara como correos de persona, cada commit
  // sería un hallazgo. Pero sólo ESAS dos formas: un dominio que las imita sigue siendo un correo
  const imita = ['alguien', 'users.noreply.github.com.ejemplo-de-verdad.com'].join('@');
  const otro = ['noreply', 'github.com.ar'].join('@');
  const { dir, cfgPath } = sandbox({
    // (la sexta: el pie que GitHub le pone a los commits de dependabot). Un renglón por elemento: con `\n` escrito
    // delante de una dirección, el exportador lee la `n` como parte del correo y frena la copia por esta misma prueba
    'a.md': ['4242+mantenedor@users.noreply.github.com', 'mantenedor@users.noreply.github.com', 'noreply@github.com', imita, otro,
      'Signed-off-by: dependabot[bot] <support@github.com>', ''].join('\n'),
  }, CFG);
  const r = correrJson(dir, cfgPath);
  assert.deepStrictEqual(r.json.hallazgos.filter((h) => h.categoria === 'email').map((h) => h.linea), [4, 5]);
});

test('Permitidos_ConMotivoSuprimeYSeCuenta', () => {
  const cfg = { ...CFG, permitidos: [{ archivo: 'docs/**', patron: 'Pepe', motivo: 'autor citado con permiso' }] };
  const { dir, cfgPath } = sandbox({ 'docs/sub/a.md': 'escrito por Pepe\n', 'b.md': 'Pepe otra vez\n' }, cfg);
  const r = correrJson(dir, cfgPath);
  assert.strictEqual(r.json.permitidos, 1);
  assert.deepStrictEqual(r.json.hallazgos.map((h) => h.archivo), ['b.md'], 'la excepción vale sólo para su glob');
});

test('NoPudoMirar_Exit2_NuncaLimpio', () => {
  const base = sandbox({ 'a.md': 'nada\n' }, CFG);
  const casos = {
    'sin --config': ['--base', base.dir, base.dir],
    'config inexistente': ['--config', path.join(base.dir, 'no-existe.json'), base.dir],
    'ruta inexistente': ['--config', base.cfgPath, path.join(base.dir, 'no-esta')],
    'opción desconocida': ['--config', base.cfgPath, '--quick', base.dir],
  };
  for (const [nombre, args] of Object.entries(casos)) {
    const r = correr(args, base.dir);
    assert.strictEqual(r.code, 2, `${nombre}: exit 2 (salió ${r.code}) ${r.err}`);
    assert.match(r.err, /no pude mirar/, nombre);
  }
  const configsRotas = {
    'JSON roto': '{ "terminos": [',
    'regex que no compila': JSON.stringify({ patrones: [{ nombre: 'x', categoria: 'y', regex: '(' }] }),
    'excepción sin motivo': JSON.stringify({ permitidos: [{ archivo: '**' }] }),
    'término sin categoría': JSON.stringify({ terminos: [{ patron: 'X' }] }),
  };
  for (const [nombre, contenido] of Object.entries(configsRotas)) {
    const { dir, cfgPath } = sandbox({ 'a.md': 'nada\n' }, contenido);
    const r = correr(['--config', cfgPath, dir], dir);
    assert.strictEqual(r.code, 2, `${nombre}: exit 2 (salió ${r.code})`);
  }
});

test('Binario_SinLeerEsHallazgo_SalvoPermitido', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]);
  const cfg = {
    ...CFG,
    binariosPermitidos: ['**/*.woff2'],
    permitidos: [{ archivo: 'img/logo.png', motivo: 'logo propio, revisado a mano' }],
  };
  const { dir, cfgPath } = sandbox({ 'img/captura.png': png, 'img/logo.png': png, 'fuentes/a.woff2': png }, cfg);
  const r = correrJson(dir, cfgPath);
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(r.json.hallazgos.map((h) => [h.archivo, h.categoria]), [['img/captura.png', 'sin-leer']]);
  assert.strictEqual(r.json.permitidos, 1);
});

test('Lista_RutasRelativasAlArchivoYFallaSiFalta', () => {
  const { dir, cfgPath } = sandbox({ 'a.md': 'Acmecorp\n', 'b.md': 'limpio\n' }, CFG);
  const lista = path.join(dir, 'lista.txt');
  fs.writeFileSync(lista, '# comentario\nb.md\n');
  assert.strictEqual(correr(['--config', cfgPath, '--list', lista], dir).code, 0, 'sólo mira lo de la lista');
  fs.writeFileSync(lista, 'b.md\nfantasma.md\n');
  const r = correr(['--config', cfgPath, '--list', lista], dir);
  assert.strictEqual(r.code, 2, 'una ruta de la lista que no existe no se da por limpia');
  assert.match(r.err, /fantasma\.md/);
});

test('Excluir_PorGlobNoSeMira', () => {
  const cfg = { ...CFG, excluir: ['privado/**'] };
  const { dir, cfgPath } = sandbox({ 'privado/x.md': 'Acmecorp\n', 'a.md': 'ok\n' }, cfg);
  const r = correrJson(dir, cfgPath);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.json.excluidos, 2, 'privado/x.md + la propia config');
});

test('Json_TraeConteosPorCategoriaYArchivo', () => {
  const { dir, cfgPath } = sandbox({ 'a.md': 'Acmecorp y Pepe\n', 'b.md': 'Acmecorp\n' }, CFG);
  const r = correrJson(dir, cfgPath);
  assert.deepStrictEqual(r.json.porCategoria, { cliente: 2, persona: 1 });
  assert.deepStrictEqual(r.json.porArchivo, { 'a.md': 2, 'b.md': 1 });
  for (const h of r.json.hallazgos) assert.deepStrictEqual(Object.keys(h).sort(), ['archivo', 'categoria', 'linea', 'regla', 'texto']);
});

// story 8.10.2, AC 17 — el pase adversarial de la 8.10.1 (causa 4): el conteo por archivo se rearmaba como objeto y un
// archivo de nombre numérico (`7`) quedaba primero aunque tuviera un solo hallazgo, y podía empujar fuera de los 15
// primeros a uno con más. Y la carpeta se recorría en el orden del sistema de archivos (en Linux, otro que en la Mac).
test('8.10.2 T17 Detector_Report_SortedByCount_NumericNameDoesNotJump — el informe ordena por cantidad aunque un archivo tenga nombre de número', () => {
  const archivos = { 7: 'ZORB\n', 'zz.md': 'ZORB\nZORB\nZORB\n', 'a/q.md': 'ZORB\nZORB\nZORB\n', 'a/y.md': 'ZORB\nZORB\n', 'b/x.md': 'ZORB\nZORB\n' };
  for (let i = 1; i <= 15; i++) archivos[`b/f${i}.md`] = 'ZORB\nZORB\n';
  const { dir, cfgPath } = sandbox(archivos, { terminos: [{ patron: 'ZORB', categoria: 'cliente', palabra: true }] });
  const r = correr(['--config', cfgPath, '--base', dir, dir], dir);
  assert.strictEqual(r.code, 1, r.err);
  const top = r.out.split('Archivos con más hallazgos:\n')[1].split('\n').filter((l) => /^\s+\d+\s{2}/.test(l))
    .map((l) => { const [, n, f] = /^\s+(\d+)\s{2}(.+)$/.exec(l); return [Number(n), f]; });
  assert.strictEqual(top.length, 15);
  assert.deepStrictEqual(top.slice(0, 2), [[3, 'a/q.md'], [3, 'zz.md']], 'de mayor a menor; empate, por ruta');
  assert.ok(top.every(([n], i) => i === 0 || n <= top[i - 1][0]), 'el orden no sube en ningún lado');
  assert.ok(!top.some(([, f]) => f === '7'), 'el archivo con un solo hallazgo queda fuera de los 15 primeros');
  // el detalle sigue el orden de nombre del recorrido, no el del sistema de archivos
  const det = correr(['--config', cfgPath, '--base', dir, '--detail', dir], dir).out.split('Detalle:\n')[1]
    .split('\n').filter(Boolean).map((l) => l.trim().split(':')[0]);
  const vistos = [...new Set(det)];
  assert.deepStrictEqual(vistos, [...vistos].sort(), 'los archivos se recorren en orden de nombre');
});

// story 8.10.2, pase adversarial — el recorrido de una carpeta salteaba en silencio los enlaces simbólicos (ni mirados ni
// excluidos): con un nombre prohibido en el archivo de destino, el detector decía «limpio». Ahora se mira lo que
// apuntan (una vez, aunque el enlace dé la vuelta), y un enlace roto es un «no pude mirar».
test('8.10.2 T23 Detector_Symlinks_AreLookedAt — un enlace simbólico se mira; uno roto no se da por limpio', (t) => {
  const { dir, cfgPath } = sandbox({ 'afuera/real.txt': 'Acmecorp\n', 'adentro/ok.md': 'nada\n', 'adentro/sub/x.md': 'nada\n' }, CFG);
  const base = path.join(dir, 'adentro');
  try {
    fs.symlinkSync(path.join(dir, 'afuera', 'real.txt'), path.join(base, 'enlace.txt'));
    fs.symlinkSync(path.join(base, 'sub'), path.join(base, 'otra'));   // a una carpeta
    fs.symlinkSync(base, path.join(base, 'sub', 'vuelta'));           // un ciclo
  } catch (e) {
    t.skip(`NO MEDIDO: este sistema no deja crear enlaces simbólicos (${e.code})`);
    return;
  }
  const r = correrJson(base, cfgPath, [base]);
  assert.strictEqual(r.code, 1, `el nombre del archivo apuntado se ve\n${r.err}`);
  assert.deepStrictEqual(r.json.hallazgos.map((h) => h.archivo), ['enlace.txt']);
  fs.symlinkSync(path.join(dir, 'no-existe'), path.join(base, 'roto.txt'));
  const roto = correr(['--config', cfgPath, '--base', base, base], base);
  assert.strictEqual(roto.code, 2, 'un enlace roto no se da por limpio');
  assert.match(roto.err, /roto\.txt/);
});

// T13 (story 8.4, AC 15): la contraseña entre comillas que la auditoría marcó ALTO y el detector no veía —la regla
// de cadenas de conexión corta en la comilla—. Los marcadores de una plantilla (`$X`, `{0}`, `%X%`, `***`, `<clave>`) y
// un booleano (`requirePassword="true"`) no son una contraseña.
test('Detector_SecretoEntreComillas', () => {
  const lineas = [
    'Password="Zq9xw7Lk"',
    '<add key="x" bizuit:emailPassword="Zq9xw7Lk" />',
    'Password="***"',
    'Password="$X"',
    'Password="{0}"',
    'Password="%X%"',
    'Password="<password>"',
    '<input requirePassword="true" showPassword="false" />',
  ];
  const { dir, cfgPath } = sandbox({ 'app.config': `${lineas.join('\n')}\n` }, CFG);
  const r = correrJson(dir, cfgPath);
  assert.strictEqual(r.code, 1);
  const secretos = r.json.hallazgos.filter((h) => h.categoria === 'secreto');
  assert.deepStrictEqual(secretos.map((h) => [h.linea, h.regla]), [[1, 'clave-entre-comillas'], [2, 'clave-entre-comillas']],
    `sólo las dos contraseñas reales; los marcadores no disparan:\n${JSON.stringify(r.json.hallazgos, null, 1)}`);
  for (const h of secretos) assert.ok(!h.texto.includes('Zq9xw7Lk') && h.texto.endsWith('***'), `enmascarada: ${h.texto}`);
  // El exportador (8.4) decide texto o binario con la MISMA regla que el detector: se exporta en vez de copiarse.
  const { esBinario } = require(DETECTOR);
  assert.strictEqual(typeof esBinario, 'function', 'detector.js exporta esBinario');
  assert.strictEqual(esBinario(Buffer.from([0x41, 0x00, 0x42])), true);
  assert.strictEqual(esBinario(Buffer.from('texto plano\n')), false);
});

// ── T27 · AC 30 (8.4, vuelta 1 de revisión) ─────────────────────────────────────────────────────────────────────
// Un término que distingue mayúsculas se escapaba en OTRA caja dentro de un identificador (`tycon-prod-sol`,
// `/api/globex/…`): la copia real salía con el detector en cero y el nombre del cliente adentro. La palabra común en
// prosa no es un hallazgo: en minúscula, el nombre corto de un cliente puede ser una palabra de todos los días (`sol`)
// o el principio de otro identificador (`globexImage`).
test('Detector_OtraCajaEnIdentificador', () => {
  const cfg = {
    terminos: [
      { patron: 'SOL', categoria: 'cliente', palabra: true, mayusculas: true },
      { patron: 'Globex', categoria: 'cliente', palabra: true, mayusculas: true },
      { patron: 'AcmeCorp', categoria: 'cliente' },
    ],
  };
  const lineas = [
    'el llavero tycon-prod-sol', //           1 · pegado a un guion
    'GET /api/globex/ordenes', //            2 · entre barras
    "import { X } from '@globex/ui';", //    3 · después de @
    "project: 'globex'", //                  4 · solo entre comillas
    'EL CASO GLOBEX: seguía', //             5 · todo en mayúsculas, como palabra
    'el repo acme-corp', //                  6 · un nombre de dos partes, separado
    'lo usa Acme Corp', //                   7 · ídem, con espacio
    'hay que tomar sol', //                  8 · la palabra común
    'no hay nada nuevo bajo el sol.', //     9 · al final de una oración
    'el control globexImage del form', //    10 · pegado a letras: no es identificador del cliente
    'repos/backend-sol/.tycon/x.json', //    11 · en una ruta
    'inputs: engram_project=globex', //      12 · el valor de una asignación
  ];
  const { dir, cfgPath } = sandbox({ 'a.md': `${lineas.join('\n')}\n` }, cfg);
  const r = correrJson(dir, cfgPath);
  assert.strictEqual(r.code, 1, r.err);
  assert.deepStrictEqual([...new Set(r.json.hallazgos.map((h) => h.linea))].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 11, 12],
    `hallazgos: ${JSON.stringify(r.json.hallazgos.map((h) => [h.linea, h.regla, h.texto]))}`);
  assert.ok(r.json.hallazgos.every((h) => h.categoria === 'cliente'), 'cada uno cuenta como el cliente que es');
  assert.ok(r.json.hallazgos.filter((h) => h.linea === 1).every((h) => /SOL/.test(h.regla)), 'la regla nombra el término');
});

// story 8.10 · el freno revisa textos en memoria (el índice de un commit) con un filtro previo: una regla de término sólo se
// evalúa si el texto trae sus letras, y el freno pide sólo las categorías de nombres. Lo que da tiene que ser lo mismo que
// da el archivo, variante por variante: el filtro acelera, nunca pierde.
test('Detector_ReviewTextInMemory_SameAsFileAndCategoryFilter', () => {
  // eslint-disable-next-line global-require
  const det = require(DETECTOR);
  const cfg = {
    terminos: [
      { patron: 'ZORB', categoria: 'cliente', palabra: true, mayusculas: true },
      { patron: 'Globex', categoria: 'cliente', palabra: true, mayusculas: true },
      { patron: 'AcmeTracking', categoria: 'cliente' },
      { patron: 'Vandelay', categoria: 'persona', palabra: true },
    ],
  };
  const texto = [
    'el llavero tycon-prod-zorb', //     otra caja, pegado a un guion
    'EL CASO GLOBEX: seguía', //          todo en mayúsculas
    'el repo acme-tracking', //           separado en partes
    'lo firmó Vandelay', //               persona
    'avisar a juana@empresa.com.ar', //   un email (el de ejemplo del archivo, permitido en la copia)
    'nada que ver acá',
  ].join('\n');
  const { dir, cfgPath } = sandbox({ 'a.md': `${texto}\n` }, cfg);
  const archivo = correrJson(dir, cfgPath).json.hallazgos.map((h) => [h.linea, h.categoria, h.regla, h.texto]);
  const config = det.cargarConfig(cfgPath);
  const memoria = det.reviewText(config, `${texto}\n`, 'a.md').hallazgos.map((h) => [h.linea, h.categoria, h.regla, h.texto]);
  assert.deepStrictEqual(memoria, archivo, 'en memoria, lo mismo que en el archivo');
  assert.deepStrictEqual([...new Set(archivo.map((h) => h[0]))].sort(), [1, 2, 3, 4, 5], 'las cuatro variantes y el email');
  const nombres = det.reviewText(config, `${texto}\n`, 'a.md', { categorias: new Set(['cliente', 'persona']) }).hallazgos;
  assert.deepStrictEqual(nombres.map((h) => h.linea), [1, 2, 3, 4], 'con el filtro de categorías, sólo los nombres');
  // la misma config desde un texto (la lista del índice de un commit) da lo mismo que desde el disco
  const desdeTexto = det.cargarConfig('lista-del-indice.json', fs.readFileSync(cfgPath, 'utf8'));
  assert.deepStrictEqual(det.reviewText(desdeTexto, `${texto}\n`, 'a.md').hallazgos, det.reviewText(config, `${texto}\n`, 'a.md').hallazgos);
});

// T12 (story 8.6, AC 13): un proceso exportado con la organización como sufijo del nombre (`<algo>__<org>.bpmn`) es un
// hallazgo aunque la organización no esté en ninguna lista: el patrón es de forma. Como el exportador le pasa al
// detector la lista de rutas de la copia, cubre también el nombre del archivo a la salida. Las líneas se arman
// pegando partes para que este archivo, que se exporta, no traiga el patrón literal.
test('Detector_SufijoDeOrganizacionEnNombre', () => {
  const lineas = [
    `tests/fixtures/bpmn/alta${'__'}acme-demo.bpmn`, // 1 · una organización que no está en CFG
    `x${'__'}y.vdw`, //                                     2 · el formato de diseño, también
    'procesoconforms_v1.bpmn', //                           3 · un solo guion bajo
    `notas${'__'}x.md`, //                                  4 · otra extensión
    `${'__'}init${'__'}.py`, //                             5 · el archivo de Python
    `ALTA${'__'}ZORBLAX.BPMN`, //                            6 · la extensión en otra caja (pase adversarial, 5b)
  ];
  const { dir, cfgPath } = sandbox({ 'rutas.txt': `${lineas.join('\n')}\n` }, CFG);
  const r = correrJson(dir, cfgPath);
  assert.strictEqual(r.code, 1, r.err);
  assert.deepStrictEqual(r.json.hallazgos.map((h) => [h.linea, h.categoria, h.regla]),
    [[1, 'cliente', 'nombre-con-sufijo-de-organizacion'], [2, 'cliente', 'nombre-con-sufijo-de-organizacion'],
      [6, 'cliente', 'nombre-con-sufijo-de-organizacion']],
    `hallazgos: ${JSON.stringify(r.json.hallazgos)}`);
});

// T21 (story 8.5): una licencia ajena que no se puede redistribuir no sale en una copia pública
test('T21 Detector_ForeignLicense — el aviso de derechos reservados y la licencia propietaria son hallazgo; la prosa no', () => {
  // armadas por partes: este archivo sale en la copia pública y el detector lo mira como a cualquier otro
  const reserved = ['All', 'rights', 'reserved'].join(' ');
  const { dir, cfgPath } = sandbox({
    'skills/acme-docs/LICENSE.txt': `© 2025 AcmeCorp, Inc. ${reserved}.\n`,
    'skills/acme-docs/SKILL.md': `---\nname: acme-docs\n${'license'}: Proprietary. LICENSE.txt has complete terms\n---\n`,
    'skills/acme-other/NOTICE': `Copyright 2026 Zorblax Labs — ${reserved}\n`,
    'guides/licencias.md': 'Una licencia propietaria se reconoce por el literal `All rights reserved`; la de arriba es `license: Proprietary`.\n',
  }, CFG);
  const r = correrJson(dir, cfgPath);
  assert.strictEqual(r.code, 1);
  const hits = r.json.hallazgos.filter((h) => h.categoria === 'foreign-license').map((h) => h.archivo).sort();
  assert.deepStrictEqual(hits, ['skills/acme-docs/LICENSE.txt', 'skills/acme-docs/SKILL.md', 'skills/acme-other/NOTICE']);
  assert.ok(!r.json.hallazgos.some((h) => h.archivo === 'guides/licencias.md'), 'la frase suelta en prosa no es hallazgo');
  const clean = sandbox({ 'a.md': 'Una guía genérica sobre revisores.\n' }, CFG);
  assert.strictEqual(correrJson(clean.dir, clean.cfgPath).code, 0, 'el contrato 0/1/2 no cambia');
});

// ── story 8.10.1, segunda vuelta (pase adversarial de la primera) ──────────────────────────────────────────────

// T31 (causa C8): `main()` escribía el informe y llamaba `process.exit()` enseguida. Por un pipe, un informe largo
// llegaba cortado y sin aviso (8.192 bytes por `spawnSync`): el código de salida estaba bien y el detalle, no.
test('T31 Detector_LongReportThroughAPipe_ArrivesWhole — un informe largo por un pipe llega entero', () => {
  const lines = [];
  for (let i = 0; i < 900; i++) lines.push(`fila ${i}: lo pidió Pepe para Acmecorp`);
  const { dir, cfgPath } = sandbox({ 'a.md': `${lines.join('\n')}\n` }, CFG);
  const r = correr(['--config', cfgPath, '--base', dir, '--json', dir], dir);
  assert.strictEqual(r.code, 1, r.err);
  assert.ok(r.out.length > 70000, `la sonda tiene que pasar el tamaño de un pipe (llegaron ${r.out.length} bytes)`);
  let json = null;
  assert.doesNotThrow(() => { json = JSON.parse(r.out); }, 'la salida llegó cortada: no es JSON');
  assert.strictEqual(json.hallazgos.length, 1800, 'dos hallazgos por fila, los 1.800');
  const detail = correr(['--config', cfgPath, '--base', dir, '--detail', dir], dir);
  assert.strictEqual(detail.code, 1);
  assert.strictEqual(detail.out.split('\n').filter((l) => l.includes('[persona/Pepe]')).length, 900, 'el detalle, con sus 900 filas');
  // el contrato 0/1/2 no cambia: sin config sigue siendo 2 y lo dice por stderr
  const none = correr([dir], dir);
  assert.strictEqual(none.code, 2);
  assert.match(none.err, /no pude mirar/);
});

// T32 (causa C10): un término de palabra entera que distingue mayúsculas era invisible justo después de un escape
// (`\n`, `\t`, `\r\n` dentro de una cadena JSON o de un printf) o entre `%20`: la letra del escape y el dígito del
// código contaban como «pegado a otra palabra». El borde ahora los reconoce.
test('T32 Detector_WholeWordAfterAnEscape — un nombre justo después de un salto escapado o de %20 se ve', () => {
  // eslint-disable-next-line global-require
  const det = require(DETECTOR);
  const cfg = det.cargarConfig('lista.json', JSON.stringify({
    terminos: [
      { patron: 'ZORB', categoria: 'cliente', palabra: true, mayusculas: true },
      { patron: 'Globex', categoria: 'cliente', palabra: true, mayusculas: true },
      { patron: 'Vandelay', categoria: 'persona', palabra: true },
    ],
  }));
  const hits = (line) => det.reviewText(cfg, line, 'a.json').hallazgos.length;
  const seen = [
    JSON.stringify({ stdout: 'primera\nZORB aprobó' }), //        \n dentro de una cadena JSON
    JSON.stringify({ stdout: 'uno\tGlobex dos' }), //             \t
    JSON.stringify({ stdout: 'uno\r\nGlobex dos' }), //           \r\n
    "printf 'uno\\nZORB dos'", //                                 un printf de un .sh
    'https://x.example/_git/Mi%20Globex%20Repo', //               entre %20
    'https://x.example/o/Otro%20ZORB/_git/R', //                  después de %20
    JSON.stringify({ quien: 'firma\nVandelay' }), //              una persona
  ];
  for (const line of seen) assert.strictEqual(hits(line), 1, `no vio el nombre en: ${line}`);
  // lo que sigue sin ser un hallazgo: pegado a otra palabra de verdad
  for (const line of ['el control GlobexImage del form', 'AZORB no es', 'un 20ZORB cualquiera', 'XZORB']) {
    assert.strictEqual(hits(line), 0, `tomó por el nombre algo pegado a otra palabra: ${line}`);
  }
});

// story 8.10.3, tanda C (pase adversarial, traversal-completeness-2 y false-negative-classification-2): un término de
// palabra entera y caja exacta escrito en caja MIXTA (`ZetaRepo`, el nombre de un repo) no se veía pegado después de otra
// palabra: la forma pegada se armaba con la inicial en mayúscula y el resto en minúscula (`Zetarepo`), que no es su
// grafía. Con el nombre de un producto adelante (`AcmeZetaRepoBackEnd`, el nombre de un sitio; `DeployZetaRepoStaging`,
// una etapa de pipeline) pasaba el detector, y el control de nombres pegados del exportador sólo mira el prefijo.
test('8.10.3 Detector_MixedCaseTermGluedAfterAnotherWord_IsSeen — la grafía propia del término, pegada en medio de un nombre', () => {
  // eslint-disable-next-line global-require
  const det = require(DETECTOR);
  const cfg = det.cargarConfig('lista.json', JSON.stringify({
    terminos: [
      { patron: 'ZetaRepo', categoria: 'interno', palabra: true, mayusculas: true },
      { patron: 'ZETARepo', categoria: 'interno', palabra: true, mayusculas: true },
      { patron: 'Globex', categoria: 'cliente', palabra: true, mayusculas: true },
    ],
  }));
  const hits = (line) => det.reviewText(cfg, line, 'a.md').hallazgos.length;
  for (const line of ['el sitio AcmeZETARepoBackEnd del servidor', 'stage: DeployZetaRepoStaging', 'const x = myZetaRepo;', 'tenant1ZETARepoBackEnd']) {
    assert.strictEqual(hits(line), 1, `no vio el nombre pegado después de otra palabra: ${line}`);
  }
  // lo que sigue sin ser un hallazgo del detector: otra palabra que empieza igual, y el prefijo (lo mira el exportador)
  for (const line of ['el myZetaRepository de siempre', 'la clase ZetaRepoBackend', 'el control GlobexImage del form']) {
    assert.strictEqual(hits(line), 0, `tomó por el nombre lo que no lo es (o lo contó dos veces): ${line}`);
  }
});
