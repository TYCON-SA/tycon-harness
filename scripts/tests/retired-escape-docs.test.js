'use strict';
// retired-escape-docs.test.js — ninguna guía ofrece un escape que ya no apaga nada.
//
// Lo que no se puede perder:
//   · la lista de escapes retirados sale del catálogo de firmas (el campo `retired` de scripts/lib/signatures.js), nunca
//     de una lista escrita acá: un escape que se retire después entra solo;
//   · cada párrafo, viñeta o fila de tabla de los .md publicados que nombra un escape retirado dice que ya no apaga nada,
//     o figura en EXCEPCIONES con su archivo, un fragmento de su texto y el motivo; una excepción cuyo texto ya no
//     aparece hace fallar la prueba;
//   · las guías que ofrecían esos escapes como salida dicen la de hoy: la emergencia que la persona firma en su terminal;
//   · un perfil del equipo que nombra un escape retirado se sigue leyendo: la marca no cambia los ids;
//   · sin escapes retirados en el catálogo, o sin guías que recorrer, la prueba sale roja: no da verde sin medir.
//
// Cubre sólo los escapes retirados del catálogo: una afirmación nueva sobre otra cosa sigue sin control.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const CATALOGO = path.join(RAIZ, 'scripts', 'lib', 'signatures.js');

// lo que dice que el escape ya no apaga nada, en castellano o en inglés
const MARCA = /ya no|ya nada|no apaga|no lo acepta|retirad|no longer|retired/i;
// las carpetas y los archivos de la raíz que se publican como guía
const CARPETAS = ['guides', 'skills', 'agents', 'commands', 'packs'];
const DE_LA_RAIZ = /^(INSTALL\.md|README.*\.md)$/;

// Los párrafos que nombran un escape retirado por otro motivo legítimo. El fragmento se busca con los espacios y los
// saltos de línea juntados en uno: no depende del número de línea.
const EXCEPCIONES = [
  { archivo: 'guides/safety-guard.md', fragmento: 'lo aceptan `TYCON_SAFETY_OFF`, `TYCON_PROD_LINT`, la emergencia ni saltear el pase adversarial',
    motivo: 'dice qué no se aprueba con un click; que esas variables ya no apagan nada lo dice la sección de la emergencia' },
  { archivo: 'guides/safety-guard.md', fragmento: 'reescribió el comando con `TYCON_SAFETY_OFF=1` por su cuenta y commiteó',
    motivo: 'el caso que explica por qué el freno tiene una sola salida, contado en pasado' },
  { archivo: 'guides/firmas-del-arnes.md', fragmento: '| `escape-phrases` | `escape:TYCON_SAFETY_OFF`, `escape:TYCON_PROD_LINT`',
    motivo: 'la tabla generada de los grupos lista ids: el grupo los sigue trayendo para que un perfil viejo se lea igual' },
];

/** Los escapes retirados del catálogo: id, nombre de la variable y la salida que queda. Lanza si no hay ninguno. */
function retirados(cat) {
  const r = (cat.SIGNATURES || []).filter((s) => s.retired).map((s) => ({ id: s.id, nombre: s.id.replace(/^escape:/, ''), salida: s.retired }));
  if (!r.length) throw new Error('la prueba no mide nada: el catálogo de firmas no trae ningún escape retirado');
  return r;
}

/** Los .md publicados bajo `raiz`, como rutas relativas. Lanza si no encuentra ninguno. */
function guiasPublicadas(raiz) {
  const out = [];
  const recorrer = (rel) => {
    let entradas;
    try { entradas = fs.readdirSync(path.join(raiz, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const hijo = path.posix.join(rel, e.name);
      if (e.isDirectory()) recorrer(hijo);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(hijo);
    }
  };
  for (const c of CARPETAS) recorrer(c);
  let raices = [];
  try { raices = fs.readdirSync(raiz); } catch { raices = []; }
  for (const f of raices) if (DE_LA_RAIZ.test(f)) out.push(f);
  if (!out.length) throw new Error(`la prueba no mide nada: no encontré ningún .md publicado en ${raiz}`);
  return out.sort();
}

/**
 * Las unidades de lectura de un .md: un párrafo, una viñeta con sus renglones de continuación, una fila de tabla, un
 * título o un bloque de código entero. Cada una con su primer renglón.
 */
function unidades(texto) {
  const out = [];
  let cur = null;
  let enCodigo = false;
  const cerrar = () => { if (cur) out.push(cur); cur = null; };
  texto.split('\n').forEach((l, i) => {
    const n = i + 1;
    if (/^\s*(```|~~~)/.test(l)) {
      if (!enCodigo) { cerrar(); cur = { linea: n, texto: l }; enCodigo = true; } else { cur.texto += `\n${l}`; enCodigo = false; cerrar(); }
      return;
    }
    if (enCodigo) { cur.texto += `\n${l}`; return; }
    if (!l.trim()) { cerrar(); return; }
    if (/^#{1,6}\s/.test(l)) { cerrar(); out.push({ linea: n, texto: l }); return; }
    if (!cur || /^\s*([-*+]\s|\d+[.)]\s|\|)/.test(l)) { cerrar(); cur = { linea: n, texto: l }; return; }
    cur.texto += `\n${l}`;
  });
  cerrar();
  return out;
}

const plano = (t) => t.replace(/\s+/g, ' ');

/**
 * Los párrafos que ofrecen un escape retirado: lo nombran sin decir que ya no apaga nada y no son una excepción.
 * Devuelve los hallazgos (`archivo:línea: …`) y las excepciones que no encontraron su texto.
 */
function ofrecimientos(raiz, nombres, excepciones = EXCEPCIONES) {
  const nombra = new RegExp(`\\b(${nombres.join('|')})\\b`);
  const hallazgos = [];
  const usadas = new Set();
  for (const rel of guiasPublicadas(raiz)) {
    const texto = fs.readFileSync(path.join(raiz, rel), 'utf8');
    for (const u of unidades(texto)) {
      if (!nombra.test(u.texto)) continue;
      const exc = excepciones.find((e) => e.archivo === rel && plano(u.texto).includes(e.fragmento));
      if (exc) { usadas.add(exc); continue; }
      if (MARCA.test(u.texto)) continue;
      hallazgos.push(`${rel}:${u.linea}: ${plano(u.texto).slice(0, 160)}`);
    }
  }
  const huerfanas = excepciones.filter((e) => !usadas.has(e)).map((e) => `${e.archivo}: «${e.fragmento}» (${e.motivo})`);
  return { hallazgos, huerfanas };
}

/** El tramo de un texto desde el renglón que matchea `inicio` hasta antes del que matchea `fin`. */
function tramo(texto, inicio, fin) {
  const lineas = texto.split('\n');
  const i = lineas.findIndex((l) => inicio.test(l));
  assert.ok(i >= 0, `no encontré ${inicio}`);
  let j = lineas.findIndex((l, k) => k > i && fin.test(l));
  if (j < 0) j = lineas.length;
  return plano(lineas.slice(i, j).join('\n'));
}

const EMERGENCIA = 'harness.js sign emergency';

test('Cursor_ElEscapeEnPasado (T5) @story-8.261 @ac-5', () => {
  for (const [rel, idioma] of [['guides/integrations/cursor.md', 'es'], ['guides/integrations/cursor.en.md', 'en']]) {
    const t = leer(rel);
    const es = idioma === 'es';
    const resumen = tramo(t, es ? /^- \*\*El modelo «Auto»/ : /^- \*\*The «Auto» model/, /^(- \*\*|$)/);
    assert.match(resumen, es ? /esquivó/ : /got around/, `${rel}: el resumen cuenta el caso en pasado`);
    assert.match(resumen, es ? /ya no apaga nada/ : /no longer turns anything off/, `${rel}: el resumen dice que la variable ya no apaga nada`);
    const adv = tramo(t, es ? /^## Advertencias/ : /^## Warnings/, /^## /);
    const freno = adv.split(es ? '- **El plan gratis' : '- **The free plan')[0];
    assert.match(freno, es ? /ya no apaga nada/ : /no longer turns anything off/, `${rel}: la advertencia dice que la variable ya no apaga nada`);
    assert.match(freno, es ? /única salida del freno es la emergencia/ : /only way out is the emergency/, `${rel}: nombra la emergencia como única salida`);
    assert.match(freno, es ? /firma en su terminal/ : /signs in their own terminal/, `${rel}: la emergencia la firma la persona en su terminal`);
    assert.match(freno, es ? /carpeta de estado/ : /state folder/, `${rel}: cita el límite de la emergencia`);
    assert.match(freno, /\.\.\/safety-guard\.md/, `${rel}: enlaza la guía del freno`);
    assert.ok(!plano(t).includes('Lo cierra otra story en curso'), `${rel}: todavía dice que lo cierra otra story`);
    assert.ok(!plano(t).includes('Another story in progress closes it'), `${rel}: todavía dice que lo cierra otra story`);
  }
});

test('Install_LaFilaDelFrenoDeSeguridad (T6) @story-8.261 @ac-6', () => {
  const fila = leer('INSTALL.md').split('\n').find((l) => l.startsWith('| `safety-guard-pre.sh` |'));
  assert.ok(fila, 'INSTALL.md no tiene la fila de safety-guard-pre.sh');
  const escape = fila.split(' | ').slice(-1)[0];
  assert.match(escape, /`TYCON_SAFETY_GUARD=0`/);
  assert.ok(escape.includes(EMERGENCIA), `la columna del escape no nombra ${EMERGENCIA}: ${escape}`);
  assert.match(escape, /terminal/);
  assert.doesNotMatch(fila, /TYCON_SAFETY_OFF/, 'la fila todavía ofrece TYCON_SAFETY_OFF');
});

test('Piezas_LaSeccionDelFreno (T7) @story-8.261 @ac-7', () => {
  const s = tramo(leer('guides/maintaining/piezas-en-detalle.md'), /^## guides\/safety-guard\.md$/, /^## /);
  assert.match(s, /`TYCON_SAFETY_GUARD=0`/);
  assert.ok(s.includes(EMERGENCIA), `la sección no nombra ${EMERGENCIA}`);
  assert.match(s, /firma en su terminal/);
  assert.doesNotMatch(s, /escape por comando \(`TYCON_SAFETY_OFF=1/, 'la sección todavía ofrece TYCON_SAFETY_OFF como escape');
  if (s.includes('TYCON_SAFETY_OFF')) assert.match(s, /`TYCON_SAFETY_OFF=1` ya no apaga nada/);
});

test('Ollama_LosTresEscapes (T8) @story-8.261 @ac-8', () => {
  for (const [rel, idioma] of [['guides/integrations/ollama.md', 'es'], ['guides/integrations/ollama.en.md', 'en']]) {
    const es = idioma === 'es';
    const adv = leer(rel).split(es ? '\n## Advertencias\n' : '\n## Warnings\n')[1];
    assert.ok(adv, `${rel}: no tiene la sección de advertencias`);
    const v = plano(adv.split('\n- **')[1] || '');
    assert.match(v, /`TYCON_SAFETY_OFF` (y|and) `TYCON_PROD_LINT`/, `${rel}: no nombra los dos retirados juntos`);
    assert.match(v, es ? /ya no apagan nada, aunque se firmen/ : /no longer turn anything off, even if someone signs them/, `${rel}: no dice que los retirados ya no apagan nada`);
    assert.match(v, es ? /emergencia/ : /emergency/, `${rel}: no nombra la emergencia`);
    assert.match(v, /`--commit`/, `${rel}: no nombra la emergencia del catálogo de producción`);
    assert.match(v, es ? /`TYCON_NEW_NAMES`\) sigue: vale sólo si la persona lo firma/ : /`TYCON_NEW_NAMES`\) is still there: it only counts if the person signs it/,
      `${rel}: no dice que TYCON_NEW_NAMES sigue siendo un escape firmado`);
  }
});

test('Firmas_LosRetiradosEnLaTabla (T9) @story-8.261 @ac-9 @ac-16', () => {
  const cat = require(CATALOGO);
  const r = retirados(cat);
  assert.deepStrictEqual(r.map((x) => x.id).sort(), ['escape:TYCON_PROD_LINT', 'escape:TYCON_SAFETY_OFF']);
  // la marca no cambia lo que leen los demás: el id, el comando y la lista de lo que sólo se firma en la terminal
  assert.strictEqual(cat.SIGNATURES.find((s) => s.id === 'escape:TYCON_SAFETY_OFF').command, 'TYCON_SAFETY_OFF=1 <comando>');
  assert.strictEqual(cat.SIGNATURES.find((s) => s.id === 'escape:TYCON_PROD_LINT').command, 'TYCON_PROD_LINT=0 <comando>');
  assert.deepStrictEqual([...cat.ONLY_IN_TERMINAL], ['escape:TYCON_SAFETY_OFF', 'escape:TYCON_PROD_LINT', 'emergency']);
  const guia = leer('guides/firmas-del-arnes.md');
  const filas = guia.split('\n');
  for (const x of r) {
    assert.ok(x.salida.startsWith(EMERGENCIA), `${x.id}: la salida no es la emergencia (${x.salida})`);
    const s = cat.SIGNATURES.find((f) => f.id === x.id);
    const l = cat.LEVELS.find((f) => f.id === x.id);
    for (const [campo, v] of [['approves', s.approves], ['ifWrong', s.ifWrong], ['LEVELS.approves', l.approves]]) assert.match(v, /retirada/, `${x.id}: ${campo} no dice que está retirada`);
    for (const [campo, v] of [['approvesEn', s.approvesEn], ['LEVELS.approvesEn', l.approvesEn]]) assert.match(v, /retired/, `${x.id}: ${campo} no dice que está retirada`);
    assert.doesNotMatch(s.ifWrong, /corre sin freno|corre sin que nadie mire/, `${x.id}: la consecuencia todavía dice que corre sin control`);
    // la tabla de las firmas: la fila del id que no es la de la tabla de niveles (ésa sigue con «3 · irreversible»)
    const firma = filas.find((f) => f.startsWith(`| \`${x.id}\` | `) && !f.startsWith(`| \`${x.id}\` | 3 ·`));
    assert.ok(firma, `${x.id}: falta su fila en la tabla de las firmas`);
    assert.ok(firma.includes('retirada: ya no apaga nada; la salida es la emergencia'), `${x.id}: la fila no dice que está retirada: ${firma}`);
    assert.ok(firma.includes(`\`${x.salida}\``), `${x.id}: la fila no trae el comando de la emergencia: ${firma}`);
    const nivel = filas.find((f) => f.startsWith(`| \`${x.id}\` | 3`));
    assert.ok(nivel && /retirada/.test(nivel) && /ya nada la pide/.test(nivel), `${x.id}: la fila de niveles no dice que está retirada: ${nivel}`);
  }
  const porQue = tramo(guia, /^`emergency` todavía no tiene una firma de hoy/, /^$/);
  assert.match(porQue, /retiradas/);
  assert.match(porQue, /approvals\.owner_only/);
  const pendiente = tramo(leer('guides/safety-guard.md'), /^`escape:TYCON_SAFETY_OFF` y `escape:TYCON_PROD_LINT` siguen en el catálogo de firmas/, /^$/);
  assert.match(pendiente, /retiradas/);
  assert.match(pendiente, /approvals\.owner_only/);
  assert.doesNotMatch(pendiente, /tanda aparte/, 'safety-guard.md todavía promete retirarlas en otra tanda');
});

test('Docs_NingunParrafoOfreceUnEscapeRetirado (T10) @story-8.261 @ac-10', () => {
  const nombres = retirados(require(CATALOGO)).map((x) => x.nombre);
  const { hallazgos } = ofrecimientos(RAIZ, nombres);
  assert.deepStrictEqual(hallazgos, [], `párrafos que ofrecen un escape retirado:\n${hallazgos.join('\n')}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-docs-'));
  try {
    fs.mkdirSync(path.join(dir, 'guides'));
    fs.writeFileSync(path.join(dir, 'guides', 'juguete.md'), '# Juguete\n\nUn párrafo sin escapes.\n\nPara saltearlo, `TYCON_SAFETY_OFF=1 <cmd>`.\n');
    const r = ofrecimientos(dir, nombres, []);
    assert.strictEqual(r.hallazgos.length, 1, r.hallazgos.join('\n'));
    assert.match(r.hallazgos[0], /^guides\/juguete\.md:5: /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RetiredDocs_SinRetiradosNoMide (T12) @story-8.261 @ac-12', () => {
  const cat = require(CATALOGO);
  const sinRetirados = { SIGNATURES: cat.SIGNATURES.map((s) => ({ ...s, retired: undefined })) };
  assert.throws(() => retirados(sinRetirados), /la prueba no mide nada/);
  assert.throws(() => retirados({}), /la prueba no mide nada/);
  const vacia = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-docs-vacia-'));
  try {
    assert.throws(() => guiasPublicadas(vacia), /la prueba no mide nada/);
    assert.throws(() => ofrecimientos(vacia, ['TYCON_SAFETY_OFF'], []), /la prueba no mide nada/);
  } finally {
    fs.rmSync(vacia, { recursive: true, force: true });
  }
});

test('Perfil_ConEscapesRetirados_IdsSiguenValidos (T13) @story-8.261 @ac-13', () => {
  const cat = require(CATALOGO);
  for (const id of ['escape:TYCON_SAFETY_OFF', 'escape:TYCON_PROD_LINT']) {
    assert.strictEqual(cat.isId(id), true, `${id}: isId`);
    assert.deepStrictEqual(cat.expand(id), [id], `${id}: expand`);
  }
  const config = require(path.join(RAIZ, 'scripts', 'lib', 'tycon-config.js'));
  const tmp = [];
  const dir = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmp.push(d); return d; };
  const cargar = (perfil) => {
    const home = dir('retired-home-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const arnes = dir('retired-arnes-');
    fs.writeFileSync(path.join(arnes, 'perfil-equipo.json'), JSON.stringify(perfil, null, 2));
    return config.cargar({ env: {}, home, arnes });
  };
  try {
    let c = cargar({ approvals: { owner_only: ['escape:TYCON_SAFETY_OFF'] } });
    assert.deepStrictEqual(c.errores, [], 'owner_only con un escape retirado se lee sin errores');
    assert.deepStrictEqual(c.valores.approvals.owner_only, ['escape:TYCON_SAFETY_OFF'], 'owner_only se lee entero');
    c = cargar({ approvals: { delegated_signing: ['escape:TYCON_PROD_LINT'] } });
    assert.deepStrictEqual(c.errores, [], 'el id retirado no es desconocido');
    const aviso = c.ignoradas.find((x) => x.clave === 'approvals.delegated_signing');
    assert.ok(aviso, 'delegated_signing con un escape de nivel 3 se descarta con su aviso');
    assert.match(aviso.motivo, /escape:TYCON_PROD_LINT \(nivel 3\).*no se delega/);
    assert.doesNotMatch(aviso.motivo, /desconocid/);
  } finally {
    for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('RetiredEscapes_ManualLinesSayRetired (T16) @story-8.261 @ac-17', () => {
  const guia = leer('guides/firmas-del-arnes.md');
  // la lista escrita a mano de lo que no acepta el click: los dos retirados siguen ahí (ONLY_IN_TERMINAL), marcados
  const lista = tramo(guia, /^Lo que no acepta el click ni el «aprobado»/, /^La contraseña que pide reinstalar/);
  for (const id of ['escape:TYCON_SAFETY_OFF', 'escape:TYCON_PROD_LINT']) {
    const item = lista.split(' - ').find((x) => x.includes(`\`${id}\``));
    assert.ok(item && /retirada/.test(item), `la lista de lo que se firma en la terminal no dice que ${id} está retirada`);
  }
  const p = plano(guia);
  assert.match(p, /Todo se aprueba sin terminal salvo dos cosas\*\*: la salida de emergencia y el `sudo` del freno de producción/);
  assert.ok(!p.includes('salvo cuatro cosas'), 'el párrafo todavía dice «salvo cuatro cosas»');
  assert.ok(!p.includes('apagar el freno de seguridad, apagar el control de producción'), 'el párrafo todavía ofrece los dos escapes');
  assert.ok(!p.includes('Lo que hoy sólo se firma en la terminal (apagar el freno de seguridad'), 'la línea del control remoto todavía ofrece los dos escapes');
  // cada excepción encuentra su texto; una que no lo encuentra falla
  const nombres = retirados(require(CATALOGO)).map((x) => x.nombre);
  for (const e of EXCEPCIONES) assert.ok(e.motivo && e.motivo.length > 20, `${e.archivo}: la excepción no dice su motivo`);
  assert.deepStrictEqual(ofrecimientos(RAIZ, nombres).huerfanas, [], 'una excepción ya no encuentra su texto');
  const inventada = { archivo: 'guides/safety-guard.md', fragmento: 'un texto que no está en ninguna guía', motivo: 'una excepción que ya no encuentra su texto' };
  const r = ofrecimientos(RAIZ, nombres, [...EXCEPCIONES, inventada]);
  assert.strictEqual(r.huerfanas.length, 1);
  assert.match(r.huerfanas[0], /un texto que no está en ninguna guía/);
});
