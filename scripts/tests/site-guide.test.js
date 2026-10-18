'use strict';
// site-guide.test.js — la guía del sitio de la organización para quien nunca lo vio: las partes de uso antes de la
// instalación (T5), las secciones de Configuración tal como las muestra la pantalla (T6), las dos guías con las mismas
// partes y las mismas capturas (T7), las capturas que existen, son PNG y pesan poco (T8), el HTML del que salió cada
// captura sin nombres reales (T9), las portadas que enlazan la guía (T10), la parte de instalación sin cambios de
// contenido (T11), y que cada captura que la guía nombra la saca el guion (T3, sin navegador: la lista del guion).
//
// Sin red y sin navegador: lee los archivos. Sacar las capturas de nuevo es `node scripts/tools/site-guide-captures.js`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const GUIA = path.join(ROOT, 'guides', 'organization-site.md');
const GUIA_EN = path.join(ROOT, 'guides', 'organization-site.en.md');
const CAPTURAS = path.join(ROOT, 'guides', 'sitio-de-la-organizacion', 'capturas');
const leer = (f) => fs.readFileSync(f, 'utf8');

/** El texto de una sección `## <título>` hasta la próxima `## `. */
const seccion = (t, titulo) => { const i = t.indexOf(`\n## ${titulo}`); if (i < 0) return null; const j = t.indexOf('\n## ', i + 4); return t.slice(i, j < 0 ? undefined : j); };
/** Las capturas que nombra un texto, en orden: `capturas/<nombre>.png`. */
const capturasDe = (t) => [...t.matchAll(/\]\(sitio-de-la-organizacion\/capturas\/([a-z0-9-]+)\.png\)/g)].map((m) => m[1]);
const titulos2 = (t) => [...t.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());

// Las partes de uso, en el orden de la guía; su versión en inglés va en la misma posición
const PARTES = [
  ['Qué es y para qué sirve', 'What it is and what it is for'],
  ['El primer ingreso', 'Signing in for the first time'],
  ['Las pestañas', 'The tabs'],
  ['Configuración, sección por sección', 'Configuration, section by section'],
  ['Qué ve cada rol', 'What each role sees'],
  ['Problemas comunes', 'Common problems'],
];
const INSTALACION = { es: 'Qué hace falta antes', en: 'What you need first' };

// La huella de la parte de instalación (desde «Qué hace falta antes» hasta el final). Si la instalación cambia a
// propósito, se cambia acá con el motivo en el mismo commit. La de hoy suma de dónde lee operaciones (la copia en un
// contenedor, con su SAS fuera de Azure) y los cambios que se aplican solos: su permiso (Contribute to pull requests,
// nunca Bypass policies), la política que deja votar al autor y el orden para encenderla; y el inicio de sesión de la
// organización (los dos modos de Microsoft y la lista), el candado de la receta de Azure (`microsoftAccounts`),
// SITE_FIRST_MAINTAINER y el rol por dentro (`site.access`); y cómo se mantiene al día (la parte común, el párrafo «Al
// día» de cada receta, Kubernetes y otras nubes, y una red cerrada); y lo que pidió una instalación desde cero
// siguiendo sólo la guía: el repo de operaciones mínimo, Node, http en la propia máquina, /readyz frenado y los
// permisos de GitHub; y que desde una imagen sin versión la primera actualización va a mano; y que con la copia de operaciones
// SITE_OPERATIONS_REPO sigue siendo obligatoria; y, en «Por dentro», la tabla de textos en dos idiomas.
const HUELLA_INSTALACION = {
  es: '6429e51f49fb60cc847595c6750fd21276267de3e62c9765d1dd06a15b352f5d',
  en: 'd12b8a130c1972f84ce1d59480f8fde4e9ef7822505dc929154c3abf4866ee0a',
};

test('T5 Guia_LasPartesDeUso @story-2.32 @ac-3 @ac-4 @ac-5 @ac-7 @ac-8', () => {
  const t = leer(GUIA);
  const inst = t.indexOf(`\n## ${INSTALACION.es}`);
  assert.ok(inst > 0, 'la parte de instalación');
  const pos = PARTES.map(([es]) => t.indexOf(`\n## ${es}`));
  assert.ok(pos.every((p, i) => p > 0 && p < inst && (i === 0 || p > pos[i - 1])), `las partes de uso, en orden y antes de la instalación: ${pos} (instalación en ${inst})`);
  // al principio, un índice que separa usar de instalar
  const antes = t.slice(0, pos[0]);
  assert.match(antes, /\[[^\]]*usar[^\]]*\]\(#/i, 'el índice lleva a la parte de uso');
  assert.match(antes, /\[[^\]]*instal[^\]]*\]\(#/i, 'el índice lleva a la parte de instalación');
  // qué es: un día real del dev y de quien mantiene, y lo que no hace
  const que = seccion(t, PARTES[0][0]);
  for (const x of ['Un día de un dev', 'Un día de quien mantiene', 'Lo que no hace']) assert.ok(que.includes(x), `«Qué es» no dice «${x}»`);
  // primer ingreso: de dónde sale la dirección y la máquina sin confirmar
  const ing = seccion(t, PARTES[1][0]);
  for (const x of ['site.url', 'aviso de la mañana', 'sin confirmar']) assert.ok(ing.includes(x), `«El primer ingreso» no dice «${x}»`);
  // cada pestaña, con al menos una captura cada una y lo que significa «no medido»
  const pest = seccion(t, PARTES[2][0]);
  for (const p of ['Inicio', 'Corridas', 'Proyectos', 'Arnés', 'Configuración']) {
    const i = pest.indexOf(`\n### ${p}`);
    assert.ok(i >= 0, `la pestaña ${p}`);
    const j = pest.indexOf('\n### ', i + 5);
    assert.ok(capturasDe(pest.slice(i, j < 0 ? undefined : j)).length >= 1, `la pestaña ${p} sin captura`);
  }
  assert.match(pest, /no medido/i, '«no medido» explicado');
  assert.match(pest, /no es cero|no quiere decir cero/i, '«no medido» no es cero');
  // la tabla de roles, con los cuatro
  const roles = seccion(t, PARTES[4][0]);
  const filas = roles.split('\n').filter((l) => l.startsWith('| ') && !/^\|\s*-/.test(l));
  for (const r of ['Quien mantiene', 'Persona confirmada', 'Persona con la máquina sin confirmar', 'Sin rol']) assert.ok(filas.some((l) => l.includes(`**${r}**`)), `la tabla de roles no tiene «${r}»`);
  // los ocho problemas del AC 8, cada uno con lo que se ve, por qué pasa y qué hacer
  const prob = seccion(t, PARTES[5][0]);
  const PROBLEMAS = [/No puedo entrar/, /Entro y no veo nada/, /No veo mis corridas/, /El sitio está frenado/, /Cargando las corridas/i, /No se pudo actualizar/i, /Proponer.*apagado/, /La primera página tarda/];
  const bloques = prob.split('\n### ').slice(1);
  for (const rx of PROBLEMAS) {
    const b = bloques.find((x) => rx.test(x.split('\n')[0]));
    assert.ok(b, `falta el problema ${rx}`);
    for (const rubro of ['Lo que se ve', 'Por qué pasa', 'Qué hacer']) assert.ok(b.includes(`**${rubro}`), `${rx}: no dice «${rubro}»`);
  }
});

/**
 * Lo que muestra la pantalla de Configuración: sus sub-pestañas en orden ([[título, [id de sección…]], …]) y el título
 * llano de cada sección (`PLANO`, que no es el `titulo` interno de SECCIONES).
 */
function subPestanas() {
  const ORG = require(path.join(ROOT, 'scripts', 'lib', 'org-config.js'));
  // los textos de la pantalla salen de la tabla: se ponen en castellano para leer sus títulos
  const { t } = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
  const codigo = ORG.pantalla().replace(/T\('(pantalla\.[A-Za-z0-9]+)'\)/g, (x, k) => `'${t('es', k).replace(/'/g, "\\'")}'`);
  const m = /var PESTANAS = (\[[^\n]*\]);/.exec(codigo);
  assert.ok(m, 'la pantalla declara sus sub-pestañas (PESTANAS)');
  const plano = /var PLANO = \{([\s\S]*?)\n {2}\};/.exec(codigo);
  assert.ok(plano, 'la pantalla declara el título llano de cada sección (PLANO)');
  const titulos = Object.fromEntries([...plano[1].matchAll(/^\s+(\w+): \{ t: '([^']+)'/gm)].map((x) => [x[1], x[2]]));
  return { ORG, titulos, pestanas: JSON.parse(m[1].replace(/'/g, '"')).map((p) => [p[1], p[2]]) };
}

test('T6 Guia_SeccionesDeConfiguracionDeLaPantalla @story-2.32 @ac-6', () => {
  const t = leer(GUIA);
  const cfg = seccion(t, PARTES[3][0]);
  assert.ok(cfg, 'la parte de Configuración');
  const { ORG, titulos, pestanas } = subPestanas();
  let desde = 0;
  for (const [titulo, ids] of pestanas) {
    const i = cfg.indexOf(`\n### ${titulo}`, desde);
    assert.ok(i >= desde, `la sub-pestaña «${titulo}», en el orden de la pantalla`);
    const j = cfg.indexOf('\n### ', i + 5);
    const bloque = cfg.slice(i, j < 0 ? undefined : j);
    let k = 0;
    for (const id of ids) {
      const t = titulos[id];
      assert.ok(t, `la pantalla no tiene título llano para «${id}»`);
      const p = bloque.indexOf(`**${t}**`, k);
      assert.ok(p >= k, `«${titulo}»: la sección «${t}», en el orden de la pantalla`);
      k = p + 1;
    }
    desde = i + 1;
  }
  // toda sección que el sitio conoce está nombrada con su título de la pantalla (una nueva en SECCIONES, sin su línea
  // en la guía, frena)
  for (const s of ORG.SECCIONES) assert.ok(titulos[s.id] && cfg.includes(`**${titulos[s.id]}**`), `la guía no nombra la sección «${titulos[s.id] || s.titulo}»`);
  // el ciclo, y lo que se ve para mirar
  for (const x of ['Revisar', 'Proponer', 'mergear', 'refresco', 'para mirar']) assert.ok(cfg.includes(x), `la parte de Configuración no dice «${x}»`);
});

test('T7 Guia_DosIdiomasMismasPartes @story-2.32 @ac-9', () => {
  const es = leer(GUIA);
  const en = leer(GUIA_EN);
  const tes = titulos2(es);
  const ten = titulos2(en);
  assert.strictEqual(ten.length, tes.length, 'la misma cantidad de partes');
  for (const [pes, pen] of PARTES) assert.strictEqual(ten.indexOf(pen), tes.indexOf(pes), `«${pes}» y «${pen}» en la misma posición`);
  assert.strictEqual(ten.indexOf(INSTALACION.en), tes.indexOf(INSTALACION.es), 'la instalación en la misma posición');
  const ces = capturasDe(es);
  assert.ok(ces.length >= 8, `la guía nombra ${ces.length} capturas`);
  assert.deepStrictEqual(capturasDe(en), ces, 'las mismas capturas, en el mismo orden');
});

test('T8 Guia_CapturasExistenYPesan @story-2.32 @ac-5 @ac-9', () => {
  const nombradas = new Set(capturasDe(leer(GUIA)));
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const n of nombradas) {
    const f = path.join(CAPTURAS, `${n}.png`);
    assert.ok(fs.existsSync(f), `falta la captura ${n}.png`);
    const b = fs.readFileSync(f);
    assert.ok(b.subarray(0, 8).equals(PNG), `${n}.png no es un PNG`);
    assert.ok(b.length < 400 * 1024, `${n}.png pesa ${Math.round(b.length / 1024)} KB (tope 400)`);
  }
  const enDisco = fs.existsSync(CAPTURAS) ? fs.readdirSync(CAPTURAS) : [];
  const sobran = enDisco.filter((f) => { const m = /^(.+)\.(png|html)$/.exec(f); return !m || !nombradas.has(m[1]); });
  assert.deepStrictEqual(sobran, [], 'archivos en la carpeta de capturas que la guía no nombra');
});

test('T9 Capturas_SinNombresReales @story-2.32 @ac-13', (t) => {
  const nombradas = capturasDe(leer(GUIA));
  const textos = nombradas.map((n) => {
    const f = path.join(CAPTURAS, `${n}.html`);
    assert.ok(fs.existsSync(f), `falta el HTML del que salió ${n}.png`);
    return [n, leer(f)];
  });
  // los correos: sólo los inventados de laboratorio
  for (const [n, h] of textos) {
    const ajenos = [...new Set((h.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).filter((c) => !/@acme\.example$/i.test(c)))];
    assert.deepStrictEqual(ajenos, [], `${n}.html trae correos fuera de acme.example`);
  }
  // la lista privada de denegación: sólo en el repo del equipo; en la copia pública no viaja
  const lista = path.join(ROOT, 'scripts', 'publishing', 'denylist.json');
  if (!fs.existsSync(lista)) { t.skip('NO MEDIDO: esta copia no trae la lista privada (scripts/publishing/denylist.json); los correos sí se midieron'); return; }
  const detector = require(path.join(ROOT, 'scripts', 'publishing', 'detector.js'));
  const cfg = detector.cargarConfig(lista);
  const hallazgos = textos.flatMap(([n, h]) => detector.reviewText(cfg, h, `capturas/${n}.html`).hallazgos.map((x) => `${n}: ${x.regla} (línea ${x.linea})`));
  // el mensaje no trae el texto encontrado: la regla y la línea alcanzan para buscarlo
  assert.deepStrictEqual(hallazgos, [], 'el HTML de una captura trae un término de la lista privada');
});

test('T10 Portadas_EnlazanLaGuia @story-2.32 @ac-11', () => {
  for (const [f, titulo, guia] of [['README.md', 'For an organization', 'guides/organization-site.en.md'], ['README.es.md', 'Para una organización', 'guides/organization-site.md']]) {
    const s = seccion(leer(path.join(ROOT, f)), titulo);
    assert.ok(s, `${f}: la sección «${titulo}»`);
    assert.ok(s.includes(`](${guia})`), `${f}: «${titulo}» no enlaza ${guia}`);
    assert.doesNotMatch(s, /piezas-del-arnes\.md#scriptssite/, `${f}: «${titulo}» todavía manda a la ficha técnica`);
  }
  const index = leer(path.join(ROOT, 'INDEX.md'));
  assert.match(index, /\| [^|]*(usar|uso|se usa)[^|]*\| `guides\/organization-site\.md`/i, 'la fila del INDEX dice que la guía también cuenta cómo se usa');
});

test('T11 Instalacion_SinCambiosDeContenido @story-2.32 @ac-14', () => {
  for (const [lado, f] of [['es', GUIA], ['en', GUIA_EN]]) {
    const t = leer(f);
    const i = t.indexOf(`\n## ${INSTALACION[lado]}`);
    assert.ok(i > 0, `${lado}: la parte de instalación`);
    assert.strictEqual(crypto.createHash('sha256').update(t.slice(i)).digest('hex'), HUELLA_INSTALACION[lado], `${lado}: la parte de instalación cambió de contenido`);
  }
});

// Las clases que las dos hojas definen a propósito igual (o compatibles), con su motivo: las demás tienen que quedar
// limitadas a su lugar, porque la pestaña Corridas carga su hoja encima de la del sitio
const COMPARTIDAS = {
  num: 'números de ancho fijo: no cambia el tamaño de nada',
  card: 'la misma tarjeta; lo que Corridas necesita distinto lo ajusta «.shell .corridas .card»',
  banda: 'la misma banda de aviso; Corridas sólo suma su variante gris',
};
/** Las reglas de una hoja: [[selector, cuerpo], …], sin comentarios y con las de @media aplanadas. */
const reglasDe = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
const clasesDe = (css) => new Set(reglasDe(css).flatMap(([sel]) => [...sel.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1])));

test('T13 SitioCss_SinChoquesConCorridas @story-2.32 @ac-15', () => {
  const site = leer(path.join(ROOT, 'scripts', 'site', 'static', 'site.css'));
  const corridas = clasesDe(require(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'runs.js')).CSS_PROPIO);
  // una excepción que ya no hace falta (una de las hojas dejó de usar el nombre) se saca de la lista
  const delSitio = clasesDe(site);
  for (const c of Object.keys(COMPARTIDAS)) assert.ok(delSitio.has(c) && corridas.has(c), `«${c}» figura entre las compartidas pero ya no está en las dos hojas`);
  const sueltas = [];
  for (const [sel] of reglasDe(site)) {
    for (const parte of sel.split(',').map((x) => x.trim())) {
      const compuestos = parte.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
      compuestos.forEach((comp, i) => {
        for (const m of comp.matchAll(/\.([A-Za-z][\w-]*)/g)) {
          const c = m[1];
          if (!corridas.has(c) || COMPARTIDAS[c]) continue;
          // limitada: el compuesto lleva su elemento o un id (header.barra, table.tabla), o algo antes la encierra
          // (#config-app .bar, .shell .corridas .pfila, .tile.blind, .form-block button.mas)
          const limitada = /^[a-z]/i.test(comp) || comp.includes('#') || i > 0 || comp.replace(`.${c}`, '').includes('.');
          if (!limitada) sueltas.push(`${parte} (.${c})`);
        }
      });
    }
  }
  assert.deepStrictEqual([...new Set(sueltas)], [], 'reglas de site.css con un nombre que también usa Corridas, sin limitar a su lugar');
});

test('Guia_PermisoCandadoYRefresco @story-2.38 @ac-8 — lo que el dueño pidió que quede escrito', () => {
  for (const [lado, f, inst, refresco] of [
    ['es', GUIA, INSTALACION.es, /«Cada cuánto se actualiza el sitio».*5 a 120 minutos.*15/s],
    ['en', GUIA_EN, INSTALACION.en, /"How often the site updates".*5 to 120 minutes.*15/s],
  ]) {
    const t = leer(f);
    const instalacion = t.slice(t.indexOf(`\n## ${inst}`));
    for (const x of ['SITE_OPERATIONS_WRITE_TOKEN', 'SITE_PROFILE_WRITE_TOKEN', 'Code: Read & write', 'Bypass policies', '403', '60', 'Referrer-Policy', 'same-origin']) {
      assert.ok(instalacion.includes(x), `${lado}: la instalación no dice «${x}»`);
    }
    assert.match(t.slice(0, t.indexOf(`\n## ${inst}`)).replace(/\s+/g, ' '), refresco, `${lado}: el campo del refresco, con su rango`);
    // el rechazo de Configuración, en «Problemas comunes», con lo que se ve, por qué pasa y qué hacer
    const titulo = lado === 'es' ? '### Configuración dice que el sitio rechazó el pedido' : '### Configuration says the site rejected the request';
    const i = t.indexOf(titulo);
    assert.ok(i > 0 && i < t.indexOf(`\n## ${inst}`), `${lado}: el problema del rechazo, en la parte de uso`);
    const bloque = t.slice(i, t.indexOf('\n### ', i + 5));
    for (const rubro of lado === 'es' ? ['Lo que se ve', 'Por qué pasa', 'Qué hacer'] : ['What you see', 'Why it happens', 'What to do']) assert.ok(bloque.includes(`**${rubro}`), `${lado}: el rechazo sin «${rubro}»`);
  }
});

test('T12 Guia_LosCambiosSeAplicanSolos @story-2.39 @ac-11 — la opción, su permiso, su registro y el orden para encenderla', () => {
  for (const [lado, f, inst, opcion, apagada] of [
    ['es', GUIA, INSTALACION.es, '**Los cambios de un mantenedor**', /viene apagada/i],
    ['en', GUIA_EN, INSTALACION.en, '"A maintainer\'s changes"', /off by default/i],
  ]) {
    const t = leer(f);
    const i = t.indexOf(`\n## ${inst}`);
    const uso = t.slice(0, i);
    const instalacion = t.slice(i);
    assert.ok(uso.includes(opcion), `${lado}: Configuración no nombra la opción`);
    assert.match(uso, apagada, `${lado}: no dice que viene apagada`);
    assert.ok(uso.includes('site.auto_apply'), `${lado}: no nombra la clave`);
    for (const x of ['Contribute to pull requests', 'Bypass policies', 'site.auto_apply']) assert.ok(instalacion.includes(x), `${lado}: la instalación no dice «${x}»`);
    assert.match(instalacion.replace(/\s+/g, ' '), lado === 'es' ? /primero la imagen nueva.*después la clave/i : /first the new image.*then the key/i, `${lado}: el orden para encenderla`);
    assert.match(uso.replace(/\s+/g, ' '), lado === 'es' ? /cambio aplicado/ : /cambio aplicado/, `${lado}: el registro de quién lo hizo`);
  }
});

test('T3 Capturas_DelSitioCorriendo @story-2.32 @ac-5 @ac-6', () => {
  // la lista de capturas que saca el guion, sin navegador: cada captura que la guía nombra la saca él
  const { CAPTURAS: lista } = require(path.join(ROOT, 'scripts', 'tools', 'site-guide-captures.js'));
  const delGuion = new Set(lista.map((c) => c.nombre));
  const faltan = capturasDe(leer(GUIA)).filter((n) => !delGuion.has(n));
  assert.deepStrictEqual(faltan, [], 'capturas que la guía nombra y el guion no saca');
  assert.ok(lista.every((c) => /^[a-z0-9-]+$/.test(c.nombre)), 'nombres fijos, en minúscula y con guiones');
  assert.ok(lista.every((c) => typeof c.espera === 'string' && c.espera.length > 3), 'cada captura dice qué texto tiene que mostrar su pantalla');
});

test('T3b Capturas_OnlyVacioORepetido_NoPasaPorBueno @story-2.32 @ac-5', () => {
  // un pedido que no saca nada no puede salir 0 («0 capturas»), y un nombre repetido no es un nombre desconocido
  const { spawnSync } = require('child_process');
  const guion = path.join(ROOT, 'scripts', 'tools', 'site-guide-captures.js');
  const out = fs.mkdtempSync(path.join(require('os').tmpdir(), 'site-guide-only-'));
  try {
    for (const only of ['', ',', ' , ']) {
      const r = spawnSync(process.execPath, [guion, '--out', out, '--only', only], { encoding: 'utf8' });
      assert.strictEqual(r.status, 2, `--only ${JSON.stringify(only)}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /al menos un nombre/);
    }
    const { args } = require(guion);
    assert.deepStrictEqual(args(['--out', out, '--only', 'sin-rol,sin-rol']).only, ['sin-rol'], 'un nombre repetido cuenta una vez');
    assert.strictEqual(args(['--out', out, '--only', 'sin-rol,sin-rol']).error, undefined);
    const desconocido = spawnSync(process.execPath, [guion, '--out', out, '--only', 'sin-rol,no-existe'], { encoding: 'utf8' });
    assert.strictEqual(desconocido.status, 2, 'un nombre que no está en la lista frena antes de abrir nada');
    assert.match(desconocido.stderr, /no conozco: no-existe/);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

// con qué se entra, la lista del sitio y el riesgo de la primera puerta abierta, en las dos guías
test('T15 2.40-Guia_InicioDeSesionYLista @story-2.40 @ac-11', () => {
  const lados = [
    ['es', GUIA, { inicio: 'El inicio de sesión de la organización', noEntro: 'No puedo entrar' },
      [/SITE_AUTH_MICROSOFT_ACCOUNTS/, /cualquier cuenta/i, /la primera puerta queda abierta/i, /todo el control está en la lista/i, /invitad/i, /cuentas personales/i, /se elige en la instalación/i],
      [/Configuración, en Personas, «Quién entra al sitio»/, /sin el portal de Microsoft/i, /sale de la lista/i]],
    ['en', GUIA_EN, { inicio: "The organization's sign-in", noEntro: 'I cannot sign in' },
      [/SITE_AUTH_MICROSOFT_ACCOUNTS/, /any account/i, /the first door is open/i, /all the control is in\s+the\s+(site's\s+)?list/i, /guest/i, /personal accounts/i, /chosen at installation/i],
      [/Configuration, in People, "Who gets into\s+the site"/, /without the Microsoft\s+portal/i, /leaves the\s+list/i]],
  ];
  for (const [lado, f, t, inicio, lista] of lados) {
    const g = leer(f);
    const sub = (titulo) => { const i = g.indexOf(`\n### ${titulo}`); assert.ok(i >= 0, `${lado}: falta «${titulo}»`); const j = g.slice(i + 5).search(/\n#{2,3} /); return g.slice(i, j < 0 ? undefined : i + 5 + j); };
    const ini = sub(t.inicio);
    for (const rx of inicio) assert.match(ini, rx, `${lado}: «${t.inicio}» no dice ${rx}`);
    for (const rx of lista) assert.match(g, rx, `${lado}: la guía no dice ${rx}`);
    // «No puedo entrar» cuenta lo de ahora: la lista, no la asignación en el portal
    const ne = sub(t.noEntro);
    assert.doesNotMatch(ne, /asign|assign/i, `${lado}: «${t.noEntro}» todavía habla de asignar en el portal`);
    assert.match(ne, lado === 'es' ? /la lista/ : /the (site's\s+)?list/, `${lado}: «${t.noEntro}» no habla de la lista`);
  }
});

// el selector de idioma, en las dos guías: cómo se elige y dónde vive la tabla de textos
test('T12 Guia_ElSelectorDeIdioma @story-2.42 @ac-8', () => {
  const lados = [
    ['es', GUIA, 'El primer ingreso', 'Por dentro, para quien mantiene el arnés',
      [/Español.{0,20}English/, /se recuerda por persona/i, /la primera vez/i, /navegador/i],
      [/scripts\/site\/texts\.js/, /agrega(r)? un texto/i, /los dos idiomas/i]],
    ['en', GUIA_EN, 'Signing in for the first time', 'Inside, for whoever maintains the harness',
      [/Español.{0,20}English/, /remembered per person/i, /the first time/i, /browser/i],
      [/scripts\/site\/texts\.js/, /add(ing)? a text/i, /both languages/i]],
  ];
  for (const [lado, f, primero, dentro, deIngreso, deDentro] of lados) {
    const t = leer(f);
    const ing = seccion(t, primero);
    assert.ok(ing, `${lado}: falta «${primero}»`);
    for (const rx of deIngreso) assert.match(ing.replace(/\s+/g, ' '), rx, `${lado}: «${primero}» no dice ${rx}`);
    const den = seccion(t, dentro);
    assert.ok(den, `${lado}: falta «${dentro}»`);
    for (const rx of deDentro) assert.match(den.replace(/\s+/g, ' '), rx, `${lado}: «${dentro}» no dice ${rx}`);
  }
});
