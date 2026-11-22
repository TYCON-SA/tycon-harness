#!/usr/bin/env node
'use strict';
// change-kind.test.js — qué cambió adentro de un archivo de código: nada que se lea, comentarios, textos o código.
//
// Caso: un cambio sólo de textos (un motivo en un .cs y seis archivos del sitio) contó como código en todos lados: pidió
// la vuelta de los nueve revisores y frenó el cierre después del tope. El lector de lib/change-kind.js separa
// comentarios, textos y código en .js, .ts, .tsx y .cs; ante la duda dice código.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/change-kind.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const ck = require(path.join(SCRIPTS, 'lib', 'change-kind.js'));

const B = (s) => Buffer.from(s, 'utf8');
const tipo = (antes, ahora, archivo = 'src/a.js') => ck.queCambio(B(antes), B(ahora), { archivo });
const espera = (filas, archivo) => {
  for (const [nombre, antes, ahora, esperado, visibles] of filas) {
    const r = tipo(antes, ahora, archivo);
    assert.strictEqual(r.tipo, esperado, `${nombre}: ${JSON.stringify(r)}`);
    assert.ok(r.motivo, `${nombre}: dice por qué`);
    if (visibles !== undefined) assert.strictEqual(r.visibles, visibles, `${nombre}: visibles — ${JSON.stringify(r)}`);
  }
};

test('T1 ChangeKind_Js_SeparaLosCuatro: espacios, comentarios, cadenas y código en un .js', () => {
  const base = "const a = f('Hola');\n// saluda\nmodule.exports = a;\n";
  espera([
    ['los mismos bytes', base, base, 'igual'],
    ['sólo la sangría', base, base.replace('module', '  module'), 'igual'],
    ['fin de línea de Windows', base, base.replace(/\n/g, '\r\n'), 'igual'],
    ['el texto de un comentario', base, base.replace('saluda', 'saluda al usuario'), 'comentarios'],
    ['un comentario nuevo', base, `${base}/* fin */\n`, 'comentarios'],
    ['una cadena', base, base.replace("'Hola'", "'Hola, mundo'"), 'textos', false],
    ['comillas dobles en vez de simples', base, base.replace("'Hola'", '"Hola"'), 'igual'],
    ['un nombre', base, base.replace('const a', 'const b').replace('= a;', '= b;'), 'codigo'],
    ['un token de más', base, base.replace("f('Hola')", "f('Hola', 1)"), 'codigo'],
    ['una cadena y código', base, base.replace("'Hola'", "'Chau'").replace('const', 'let'), 'codigo'],
    ['una cadena y un comentario: gana la cadena', base, base.replace("'Hola'", "'Chau'").replace('saluda', 'despide'), 'textos'],
    // los mismos tokens con otra separación: `+ +b` no es `++b`, y un fin de línea después de `return` cambia lo que vuelve
    ['dos signos que se pegan', 'const c = a + +b;\n', 'const c = a ++b;\n', 'codigo'],
    ['un fin de línea después de return', 'function f() { return x; }\n', 'function f() { return\nx; }\n', 'codigo'],
  ]);
});

test('T2 ChangeKind_Plantillas_LoDeLosHuecosEsCodigo: el texto de una plantilla es texto, lo de `${}` es código', () => {
  const base = 'const m = `Hola ${nombre}, tenés ${n} avisos`;\n';
  espera([
    ['el texto de un tramo', base, base.replace('tenés', 'hay'), 'textos', false],
    ['lo de un hueco', base, base.replace('${n}', '${n + 1}'), 'codigo'],
    ['un hueco nuevo', base, base.replace('avisos', '${"avisos"}'), 'codigo'],
    ['una plantilla dentro de un hueco', 'const m = `a ${`b ${c}`}`;\n', 'const m = `a ${`B ${c}`}`;\n', 'textos'],
  ]);
});

test('T3 ChangeKind_Jsx_TextoDePantallaEsVisible: en un .tsx el texto entre etiquetas es lo que se ve', () => {
  const base = [
    'export function Saludo({ nombre }: { nombre: string }) {',
    '  const [n, setN] = useState<number>(0);',
    '  return (',
    '    <div className="caja" title="Bienvenida">',
    '      <h1>Hola, {nombre}</h1>',
    '      {n > 0 && <p>Tenés {n} avisos</p>}',
    "      <a href=\"http://x\">Don't // esto es texto</a>",
    '      <Boton onClick={() => setN(n + 1)} />',
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n');
  espera([
    ['el texto de un título', base, base.replace('Hola,', 'Buenas,'), 'textos', true],
    ['el texto de un elemento condicional', base, base.replace('Tenés', 'Hay'), 'textos', true],
    ['un apóstrofo y dos barras dentro del texto', base, base.replace("Don't", 'No'), 'textos', true],
    ['un texto que se borra', base, base.replace('Hola, ', ''), 'textos', true],
    ['el valor de un atributo', base, base.replace('Bienvenida', 'Hola'), 'textos', false],
    ['un texto de pantalla y un atributo', base, base.replace('Bienvenida', 'Hola').replace('Tenés', 'Hay'), 'textos', false],
    ['lo de dentro de unas llaves', base, base.replace('n + 1', 'n + 2'), 'codigo'],
    ['una etiqueta', base, base.replace('<h1>Hola, {nombre}</h1>', '<h2>Hola, {nombre}</h2>'), 'codigo'],
    ['un atributo nuevo', base, base.replace('<Boton ', '<Boton disabled '), 'codigo'],
    ['la condición', base, base.replace('n > 0', 'n > 1'), 'codigo'],
    ['un atributo en otro renglón', base, base.replace('className="caja" title', 'className="caja"\n      title'), 'igual'],
    // React saca los espacios con un fin de línea al principio y al final de cada renglón: se ve igual
    ['el título en tres renglones', base, base.replace('<h1>Hola, {nombre}</h1>', '<h1>\n        Hola, {nombre}\n      </h1>'), 'igual'],
    ['un fin de línea que pega dos palabras', base, base.replace('Tenés {n} avisos', 'Tenés {n}\n        avisos'), 'textos', true],
  ], 'src/Saludo.tsx');
});

test('T4 ChangeKind_Tsx_GenericosNoSonJsx: los genéricos de TypeScript no se leen como etiquetas', () => {
  const base = [
    'const id = <T,>(x: T): T => x;',
    'const m = new Map<string, Array<number>>();',
    "const t = useState<string>('uno');",
    'export default () => <span>listo</span>;',
    '',
  ].join('\n');
  espera([
    ['una cadena entre genéricos', base, base.replace("'uno'", "'dos'"), 'textos', false],
    ['el texto del componente', base, base.replace('listo', 'hecho'), 'textos', true],
    ['un tipo', base, base.replace('Array<number>', 'Array<string>'), 'codigo'],
  ], 'src/a.tsx');
});

test('T5 ChangeKind_Ts_SinJsx: en un .ts el `<` no abre etiquetas', () => {
  const base = "const x = <Foo>valor;\nexport const msg: string = 'Guardado';\nif (a < b && c > d) f();\n";
  espera([
    ['una cadena', base, base.replace('Guardado', 'Listo'), 'textos', false],
    ['una comparación', base, base.replace('a < b', 'a <= b'), 'codigo'],
  ], 'src/a.ts');
});

test('T6 ChangeKind_Cs_CadenasYComentarios: las cadenas de C#, comunes, literales, interpoladas y crudas', () => {
  const base = [
    'namespace Demo;',
    '/// <summary>Usuarios del cliente.</summary>',
    'public class ClienteBizuitUsuarios {',
    '  // motivo del rechazo',
    '  private const string Motivo = "El usuario no tiene permiso";',
    '  private static readonly string Ruta = @"C:\\datos\\""uno""";',
    '  public string Saludo(string nombre) => $"Hola {nombre}, tenés {{llaves}}";',
    '  public string Varias() => $@"Fila {n}',
    'segunda";',
    '  public string Cruda() => """',
    '    texto "crudo"',
    '    """;',
    "  public char Sep = ',';",
    '  public string Url = "http://x"; // no es comentario lo de la cadena',
    '}',
    '',
  ].join('\n');
  espera([
    ['una cadena común', base, base.replace('no tiene permiso', 'no está autorizado'), 'textos', false],
    ['una cadena literal', base, base.replace('""uno""', '""dos""'), 'textos'],
    ['el texto de una interpolada', base, base.replace('tenés', 'hay'), 'textos'],
    ['el hueco de una interpolada', base, base.replace('{nombre}', '{nombre.Trim()}'), 'codigo'],
    ['una interpolada literal de dos renglones', base, base.replace('segunda', 'otra'), 'textos'],
    ['una cadena cruda', base, base.replace('"crudo"', '"cocido"'), 'textos'],
    ['un comentario de documentación', base, base.replace('Usuarios del cliente.', 'Los usuarios.'), 'comentarios'],
    ['un comentario común', base, base.replace('motivo del rechazo', 'por qué se rechaza'), 'comentarios'],
    ['un carácter: es código', base, base.replace("','", "';'"), 'codigo'],
    ['dos barras dentro de una cadena', base, base.replace('http://x', 'https://y'), 'textos'],
    ['un nombre', base, base.replace('Saludo(', 'Saludar('), 'codigo'],
    ['una línea partida en dos', base, base.replace('Saludo(string nombre) =>', 'Saludo(string nombre)\n    =>'), 'igual'],
  ], 'Features/ClienteBizuitUsuarios.cs');
});

test('T7 ChangeKind_Cs_PreprocesadorEsCodigo: una línea `#` de C# es código, también `#region`', () => {
  const base = '#region Datos\n#pragma warning disable CS0168\nint x = 1;\n#endregion\n';
  espera([
    ['el nombre de una región', base, base.replace('Datos', 'Otros'), 'codigo'],
    ['un pragma', base, base.replace('CS0168', 'CS0219'), 'codigo'],
  ], 'a.cs');
});

test('T8 ChangeKind_Directivas_SonCodigo: un comentario que puede ser una directiva no es «sólo un comentario»', () => {
  const base = "// eslint-disable-next-line no-console\nconsole.log('x');\nconst y = 2; // nota\n";
  espera([
    ['cambia la directiva', base, base.replace('no-console', 'no-alert'), 'codigo'],
    ['aparece una directiva', base, base.replace('// nota', '// @ts-ignore'), 'codigo'],
    ['un renglón en blanco entre la directiva y su línea', base, base.replace('no-console\n', 'no-console\n\n'), 'codigo'],
    ['se va la directiva', base, base.replace('// eslint-disable-next-line no-console\n', ''), 'codigo'],
    ['otro comentario, la directiva quieta', base, base.replace('nota', 'una nota'), 'comentarios'],
  ]);
  // los escáneres de seguridad y los analizadores también se silencian con un comentario
  const sin = "const q = run(sql);\n";
  for (const d of ['// snyk:ignore', '// checkov:skip=CKV_1', '// skipcq: JS-0060', '// DevSkim: ignore DS104456', '// CA2100:ignore', '// nosemgrep', '/* bandit */']) {
    for (const archivo of ['a.js', 'a.ts', 'a.cs']) {
      assert.strictEqual(tipo(sin, sin.replace(';\n', `; ${d}\n`), archivo).tipo, 'codigo', `${d} en ${archivo}`);
    }
  }
});

test('T9 ChangeKind_AnteLaDuda_Codigo: lo que no sabe leer, un lenguaje sin lector y lo que no es texto', () => {
  espera([
    ['una cadena sin cerrar', "const a = 'x;\n", "const a = 'y;\n", 'codigo'],
    ['un comentario sin cerrar', 'const a = 1; /* x\n', 'const a = 1; /* y\n', 'codigo'],
    ['una llave de más', 'f(); }\n', 'f(); } // x\n', 'codigo'],
    ['una etiqueta que cierra con otro nombre', 'const a = <b>x</i>;\n', 'const a = <b>y</i>;\n', 'codigo'],
    ['una barra que no sabe leer', "a = b++ / 2; const s = 'x';\n", "a = b++ / 2; const s = 'y';\n", 'codigo'],
  ]);
  assert.strictEqual(tipo("print('a')\n", "print('b')\n", 'a.py').tipo, 'codigo', 'un lenguaje sin lector');
  assert.strictEqual(tipo('a', 'b', 'sin-extension').tipo, 'codigo', 'sin extensión');
  const malo = ck.queCambio(Buffer.from([0xff, 0xfe, 0x41]), Buffer.from([0xff, 0xfe, 0x42]), { archivo: 'a.js' });
  assert.strictEqual(malo.tipo, 'codigo', 'bytes que no son UTF-8');
  assert.strictEqual(ck.queCambio('a', 'b', { archivo: 'a.js' }).tipo, 'codigo', 'sin los dos contenidos como Buffer');
});

test('T10 ChangeKind_ExpresionesRegulares: una expresión regular es código, también con comillas o barras adentro', () => {
  const base = "const re = /\"[^\"]*\"\\/\\//g;\nconst s = 'texto';\nconst d = a / b / c;\n";
  espera([
    ['una cadena después de la expresión', base, base.replace("'texto'", "'otro'"), 'textos'],
    ['la expresión', base, base.replace('/g', '/gi'), 'codigo'],
    ['una división', base, base.replace('a / b', 'a / d'), 'codigo'],
  ]);
  // ni el desplazamiento `<<` ni una comparación después de `++` abren JSX
  const otra = "const m = 1 << 26;\nwhile (n++ < tope) f('uno');\n";
  espera([['una cadena después de `<<` y de `++ <`', otra, otra.replace("'uno'", "'dos'"), 'textos']]);
});

test('T11 ChangeKind_ArchivosDelArnes_SeLeen: los .js de lib/ se leen sin duda, y un comentario agregado es «comentarios»', () => {
  const dir = path.join(SCRIPTS, 'lib');
  const dudas = [];
  let leidos = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    leidos++;
    const r = tipo(t, `${t}\n// una nota al final\n`, f);
    if (r.tipo !== 'comentarios') dudas.push(`${f}: ${r.tipo} (${r.motivo})`);
  }
  assert.ok(leidos > 100, `leyó ${leidos} archivos`);
  assert.ok(dudas.length <= Math.floor(leidos / 20), `más de uno de cada veinte no se dejó leer:\n${dudas.join('\n')}`);
});
