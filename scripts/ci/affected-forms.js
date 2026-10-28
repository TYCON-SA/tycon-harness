#!/usr/bin/env node
'use strict';
/**
 * ¿Qué formularios hay que probar y construir por un cambio?
 *
 * 🔴 POR QUÉ EXISTE. Los pipelines de formularios usaban dos criterios opuestos y
 * los DOS están mal en algún producto:
 *
 *   · PROBAR sólo los que cambiaron → en Totora deja pasar roturas: sus 4 formularios se
 *     importan entre sí, así que tocar uno puede romper otro sin que su prueba
 *     corra. Allá lo resuelven ESCRIBIENDO LAS DEPENDENCIAS A MANO en el YAML — correcto
 *     hoy, y desactualizado el día que alguien agregue un import, sin que nada avise.
 *   · CONSTRUIR todos siempre → en FRESNO son 33 formularios sin una sola dependencia entre ellos:
 *     se pagan 33 construcciones para tirar 32. Y en el pull request se tiran TODAS, porque ahí
 *     no se publica nada (etapa 1 del camino del paquete: "no fabrica nada que se despliegue").
 *
 * Lo correcto en los dos casos es lo mismo: **lo afectado** = lo que cambió MÁS lo que depende de
 * ello. Ni "sólo lo cambiado" (pierde roturas) ni "todos" (desperdicio). Y el grafo se DERIVA DEL
 * CÓDIGO, que es lo que hace que no se desactualice.
 *
 * Tamaños de referencia: Totora tiene 4 formularios que se importan casi todos con todos · URUTAU 8,
 * Lapacho 1, Ceibo 2 y FRESNO 33, ninguno con imports cruzados.
 *
 * 🔴 FALLA HACIA MÁS TRABAJO, NUNCA HACIA MENOS. Si no puede leer algo —una carpeta ilegible, un
 * import raro— devuelve TODOS. Construir de más cuesta minutos; construir de menos deja pasar
 * una rotura, que es el error que este guion existe para evitar.
 *
 * 🔴 "NO ENCONTRÉ NINGÚN FORMULARIO" SALE 3, NO VACÍO. Devolver vacío con exit 0 en ese caso —igual
 * que "nada afectado"— haría que quien llama no pudiera distinguir un repo mal resuelto de un
 * cambio que no toca ningún formulario, y esa confusión deja un pull request VERDE sin construir
 * ni probar nada. Por eso: vacío + exit 0 = nada afectado (legítimo) · exit 3 = no pude ver ningún
 * formulario (quien llama decide: todos, o rojo si "todos" también es vacío).
 *
 * 🔴 UN FORMULARIO BORRADO O RENOMBRADO NO AFECTA A TODOS. Sus rutas viejas ya
 * no caen dentro de ningún formulario, así que por posición serían "de afuera" → todos. Se
 * reconoce porque el diff trae `<carpeta>/package.json` y la carpeta ya no existe: esas rutas se
 * IGNORAN. Una carpeta compartida borrada (sin package.json) sigue afectando a todos.
 *
 * Uso:
 *   affected-forms.js --repo <dir> --changed <archivo|-> [--base <ref>] [--no-debt]
 *     <archivo> trae las rutas cambiadas, una por línea (lo que da `git diff --name-only`).
 *     --base   contra qué se compara la declaración de deuda (default HEAD~1; ver deltaDeDeuda).
 *     --no-debt  no suma los formularios cuya deuda cambió — lo usa el bump de versión, que
 *                pregunta "qué construyo", no "a quién juzgo".
 *     Con `-` las lee de la entrada estándar.
 *   affected-forms.js --repo <dir> --all        → lista todos (para main)
 *   affected-forms.js --repo <dir> --graph      → imprime el grafo, para revisarlo
 *   (Los nombres viejos en castellano de --no-debt y --graph siguen andando hasta el retiro.)
 *
 * Sale 0 siempre que pueda dar una respuesta utilizable (aunque sea "todos") · 3 si no encontró
 * ningún formulario en el repo (no hay respuesta utilizable: que decida quien llama), o si llegó una opción
 * con su nombre viejo y el nuevo a la vez (la opción vieja sigue andando hasta el retiro).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// Las opciones renombradas a inglés: los pipelines de los productos siguen pasando las viejas
// hasta el retiro. El traductor vive al lado y viaja con este archivo en el artefacto arnes-ci.
const { aliasLegacyOptions, LegacyOptionsError } = (() => {
  try { return require('./legacy-options.js'); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') process.stderr.write(`⚠️  legacy-options.js no cargó (${e && e.message}): los nombres viejos de este guion no se traducen\n`); return { aliasLegacyOptions: (argv) => argv, LegacyOptionsError: Error }; }
})();

/** Un formulario es una carpeta de primer nivel con package.json (la raíz no cuenta). */
function formularios(repo) {
  let e = [];
  try { e = fs.readdirSync(repo, { withFileTypes: true }); } catch (_) { return []; }
  return e.filter((x) => x.isDirectory() && !x.name.startsWith('.') && x.name !== 'node_modules'
      && fs.existsSync(path.join(repo, x.name, 'package.json')))
    .map((x) => x.name).sort();
}

function archivosDeCodigo(dir) {
  const out = [];
  const mira = (d) => {
    let e = [];
    try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const x of e) {
      if (x.name === 'node_modules' || x.name.startsWith('.')) continue;
      const p = path.join(d, x.name);
      if (x.isDirectory()) mira(p);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(x.name)) out.push(p);
    }
  };
  mira(dir);
  return out;
}

/** quién importa a quién: { formulario: Set(formularios de los que depende) } */
function grafo(repo, forms) {
  const g = {};
  for (const f of forms) g[f] = new Set();
  for (const f of forms) {
    const base = path.join(repo, f);
    for (const archivo of archivosDeCodigo(base)) {
      let txt;
      try { txt = fs.readFileSync(archivo, 'utf8'); } catch (_) { continue; }
      const rx = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
      let m;
      while ((m = rx.exec(txt))) {
        const imp = m[1];
        if (!imp.startsWith('.')) continue;             // paquete de npm: no es otro formulario
        const destino = path.normalize(path.resolve(path.dirname(archivo), imp));
        if (destino.startsWith(base + path.sep) || destino === base) continue;  // dentro de sí mismo
        if (!destino.startsWith(repo + path.sep)) continue;                     // fuera del repo
        const otro = path.relative(repo, destino).split(path.sep)[0];
        if (otro && otro !== f && forms.includes(otro)) g[f].add(otro);
      }
    }
  }
  return g;
}

/** Cono de dependientes: quiénes se rompen si cambia alguno del conjunto inicial. */
function conDependientes(g, inicial) {
  const out = new Set(inicial);
  let creció = true;
  while (creció) {
    creció = false;
    for (const [f, deps] of Object.entries(g)) {
      if (out.has(f)) continue;
      for (const d of deps) if (out.has(d)) { out.add(f); creció = true; break; }
    }
  }
  return out;
}

/**
 * Rutas que NO pueden afectar a ningún formulario, por más que vivan fuera de todos ellos.
 *
 * 🔴 La lista es CORTA a propósito y no va a crecer sin una razón medida. Cada entrada acá es un
 * agujero potencial: si me equivoco y algo de esto sí afecta al código construido, la rotura pasa
 * sin que ninguna prueba la vea. Por eso sólo entran archivos cuya relación con el código
 * construido es NINGUNA:
 *
 *   · el propio archivo del pipeline — cambiarlo no toca el código de ningún formulario, y el
 *     pipeline nuevo YA se está usando en esa misma corrida: probar los 34 no lo verifica mejor
 *     que probar uno. Es además el caso MÁS FRECUENTE (se edita el pipeline todo el tiempo), o
 *     sea donde la regla segura sería más cara.
 *   · documentación (.md) — no entra en ningún paquete.
 *
 * Todo lo demás de afuera sigue afectando a TODOS. Ante la duda, todos.
 *
 * 🔴 POR QUÉ ESTA LISTA SÍ PUEDE SER A MANO, y la del `trigger:` del pipeline no. Las dos son
 * listas escritas por una persona y las dos pueden olvidarse de algo, pero fallan para lados
 * opuestos: si al `trigger:` le falta una carpeta, el código NO SE CONSTRUYE y nadie se entera
 * (le pasa a `BD/**` en un producto del equipo). Si a ésta le falta un archivo inerte, se
 * construye DE MÁS: cuesta minutos y se nota enseguida, porque alguien ve que se redesplegaron
 * todos los formularios sin motivo. Por eso el olvido acá es barato — y por eso cada entrada que
 * se AGREGA sí es cara: es un permiso, y un permiso mal dado falla hacia el lado peligroso.
 */
const NO_AFECTAN = [
  /^azure-pipelines[^/]*\.ya?ml$/i,
  /\.md$/i,
  // 🔴 4 de los 5 repos de formularios commitean la memoria del agente (`.engram/`, el hook de
  // engram la agrega en cada commit), y aparece en el diff de cada bump de versión. Es
  // memoria de la herramienta, no código: cero relación con lo construido. Sin esta entrada,
  // casi cada merge versionaría y desplegaría TODOS los formularios (33 en FRESNO).
  /^\.engram\//,

  // 🔴 LOS ARCHIVOS DEL PROPIO ARNÉS. De todo lo que vive fuera de un formulario y dispararía
  // "afecta a TODOS", la mayoría son archivos que sólo LEE EL PIPELINE — nunca el compilador.
  //
  // Sin esta lista el arnés se haría trabajo a sí mismo, y no sólo en tiempo: en `main`,
  // tocar uno de ellos SUBE LA VERSIÓN de todos los formularios y los REDESPLIEGA, sin una
  // línea de código nueva.
  //
  // Las tres declaraciones de deuda: las lee el paso de pruebas y el de dependencias para decidir
  // qué está amparado. No entran en ningún paquete.
  /^pruebas-pendientes\.json$/i,
  /^vulnerabilidades-pendientes\.json$/i,
  /^vulnerabilidades-formularios-pendientes\.json$/i,
  // Configuración del arnés para el repo (advisors, e2e, evidencia). La leen los controles.
  /^\.tycon\//,
  // 🔴 LA EVIDENCIA DE LAS CORRIDAS. `.advisors/` guarda lo que dejan el pipeline y
  // los revisores: `findings.json`, `review-roster.json`, las matrices de verificación y los
  // registros de smoke. Se ESCRIBE en cada corrida y VIAJA por git a propósito (el .gitignore
  // canónico la deja pasar: es la evidencia de cierre). Nada de eso lo lee el compilador.
  //
  // Es la carpeta que MÁS cambia de todas, porque crece en cada story: sin esta entrada, un
  // `findings.json` viejo versionaría y mandaría a redesplegar TODOS los formularios, sin una
  // línea de código nueva.
  /^\.advisors\//,
  // Configuración del análisis de secretos. Cambiarla mueve qué reporta gitleaks, no qué compila esbuild.
  /^\.gitleaks(ignore|\.toml)$/i,
  // Qué se versiona y qué no. No cambia el código que ya está en el commit que se está construyendo.
  /^\.gitignore$/i,

  // 🔴 LO QUE NO ENTRA, Y POR QUÉ (para que nadie lo agregue creyendo que se olvidó): `scripts/` puede participar del build · `.npmrc` decide de qué registro se bajan los
  // paquetes · `package-lock.json` de la raíz es donde vive el empaquetador. Los tres SÍ cambian
  // lo que se construye, así que siguen afectando a todos.
];

/**
 * Rutas que afectan a TODOS: lo que vive fuera de cualquier formulario y lo comparten.
 * Se mira por POSICIÓN, no por lista de nombres: si el archivo cambiado no cae adentro de un
 * formulario, por definición no es de un formulario solo. La única excepción es NO_AFECTAN.
 */
function esCompartido(rel, forms) {
  if (NO_AFECTAN.some((rx) => rx.test(rel))) return false;
  const primero = rel.split('/')[0];
  return !forms.includes(primero);
}

/**
 * 🔴 LA DECLARACIÓN DE DEUDA DE PRUEBAS NO AFECTA AL PAQUETE, PERO SÍ AL VEREDICTO.
 *
 * `pruebas-pendientes.json` está arriba en NO_AFECTAN: cambiarlo no cambia una línea de lo que se
 * construye, y sin esa entrada tocarlo redesplegaría los 33 formularios de FRESNO por nada. Eso sigue
 * siendo cierto para CONSTRUIR y para VERSIONAR.
 *
 * Pero "a quién construyo" y "a quién juzgo" son dos preguntas distintas y no pueden contestarse
 * con la misma respuesta. Sin esta distinción, un pull request que dice "<un formulario> pagó su
 * deuda de pruebas" y sólo BORRA su entrada de este archivo —sin agregar una sola prueba ni el
 * jest.config.js— no probaría ni juzgaría a nadie ("el cambio toca sólo archivos que no afectan
 * a ningún formulario") y saldría VERDE. El rojo llegaría recién en `main`, donde se prueban
 * todos, con el merge ya hecho.
 *
 * Entonces: cuando el cambio toca la declaración de deuda, los formularios cuya declaración ENTRA
 * o SALE se suman a lo que hay que probar. Los dos sentidos importan, porque el veredicto falla en
 * los dos: sale una entrada y el formulario tiene que demostrar que ahora tiene pruebas; entra una
 * entrada y tiene que demostrar que de verdad no las tiene (un formulario declarado sin pruebas
 * que ejecuta pruebas también es rojo — la lista no puede sobrevivir a la deuda que declara).
 *
 * Sólo eso: se suman al conjunto A PROBAR. El bump de versión llama con `--no-debt` y su
 * comportamiento no cambia, así que tocar la declaración sigue sin redesplegar nada.
 *
 * Falla hacia más trabajo, igual que todo el resto del guion: si no puede saber qué decía la
 * declaración antes —base irresoluble, JSON ilegible— devuelve TODOS.
 */
const DEUDA = 'pruebas-pendientes.json';

/** formulario -> texto de su declaración (las dos listas). `null` si el archivo no es JSON válido. */
function declaraciones(txt) {
  let d;
  try { d = JSON.parse(txt); } catch (_) { return null; }
  const m = new Map();
  for (const lista of ['sin_pruebas', 'con_pruebas_en_rojo']) {
    for (const e of (d && d[lista]) || []) {
      if (e && e.formulario) m.set(e.formulario, `${lista}:${JSON.stringify(e)}`);
    }
  }
  return m;
}

/**
 * Formularios cuya declaración de deuda cambió entre `base` y el árbol de trabajo.
 * Devuelve { forms: [...] } o { todos: true, motivo } cuando no puede saberlo.
 */
function deltaDeDeuda(repo, base) {
  const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  try { git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]); }
  catch (_) { return { todos: true, motivo: `no pude resolver la base "${base}"` }; }

  // Que el archivo no exista en la base es legítimo (es la primera vez que se declara deuda):
  // la declaración anterior es vacía. Lo mismo del lado de ahora, si se borró el archivo entero.
  let antes;
  try { antes = declaraciones(git(['show', `${base}:${DEUDA}`])); } catch (_) { antes = new Map(); }
  let ahora;
  try { ahora = declaraciones(fs.readFileSync(path.join(repo, DEUDA), 'utf8')); } catch (_) { ahora = new Map(); }
  if (antes === null || ahora === null) return { todos: true, motivo: `${DEUDA} no se puede leer como JSON` };

  const forms = new Set();
  for (const [f, v] of ahora) if (antes.get(f) !== v) forms.add(f);
  for (const [f, v] of antes) if (ahora.get(f) !== v) forms.add(f);
  return { forms: [...forms].sort() };
}

function main(argv0) {
  let argv;
  try { argv = aliasLegacyOptions(argv0, 'cambiados:changed todos:all grafo:graph sin-deuda:no-debt', 'scripts/ci/affected-forms.js'); }
  catch (e) {
    if (!(e instanceof LegacyOptionsError)) throw e;
    console.error(`[afectados] ${e.message} — no puedo decidir: exit 3`);
    return 3;
  }
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const repo = path.resolve(arg('--repo') || process.cwd());
  const forms = formularios(repo);

  if (!forms.length) {
    console.error(`[afectados] no encontré ningún formulario en ${repo} (carpetas de primer nivel con package.json) — no puedo decidir: exit 3`);
    return 3;
  }
  if (argv.includes('--all')) { console.log(forms.join('\n')); return 0; }

  let g;
  try { g = grafo(repo, forms); }
  catch (e) {
    console.error(`[afectados] no pude leer el grafo de dependencias (${e.message}) — devuelvo TODOS, que es el lado seguro`);
    console.log(forms.join('\n')); return 0;
  }

  if (argv.includes('--graph')) {
    for (const f of forms) console.log(`${f} -> ${[...g[f]].sort().join(', ') || '(nada)'}`);
    return 0;
  }

  const src = arg('--changed');
  if (!src) { console.error('[afectados] falta --changed <archivo|-> — devuelvo TODOS'); console.log(forms.join('\n')); return 0; }
  let texto;
  try { texto = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8'); }
  catch (e) { console.error(`[afectados] no pude leer la lista de cambios (${e.message}) — devuelvo TODOS`); console.log(forms.join('\n')); return 0; }

  let cambiados = texto.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!cambiados.length) { console.error('[afectados] la lista de cambios vino vacía — no hay nada afectado'); return 0; }

  // Formulario borrado o renombrado: su carpeta ya no existe y el diff trae su package.json.
  const borrados = [...new Set(cambiados.map((c) => c.split('/')[0]))]
    .filter((f) => !forms.includes(f) && cambiados.includes(`${f}/package.json`) && !fs.existsSync(path.join(repo, f)));
  if (borrados.length) {
    console.error(`[afectados] formulario(s) borrado(s) o renombrado(s): ${borrados.join(', ')} — sus rutas viejas se ignoran (no afectan a nadie)`);
    cambiados = cambiados.filter((c) => !borrados.includes(c.split('/')[0]));
    if (!cambiados.length) { console.error('[afectados] no quedó ningún otro cambio — no hay nada afectado'); return 0; }
  }
  // La declaración de deuda no cambia lo que se construye, pero sí a quién hay que JUZGAR
  // (el porqué, largo, está arriba de deltaDeDeuda). Sólo suma al conjunto a probar.
  const porDeuda = [];
  if (!argv.includes('--no-debt') && cambiados.includes(DEUDA)) {
    const base = arg('--base') || 'HEAD~1';
    const d = deltaDeDeuda(repo, base);
    if (d.todos) {
      console.error(`[afectados] cambió ${DEUDA} y ${d.motivo} — devuelvo TODOS, que es el lado seguro`);
      console.log(forms.join('\n')); return 0;
    }
    const fantasmas = d.forms.filter((f) => !forms.includes(f));
    if (fantasmas.length) {
      console.error(`[afectados] la deuda menciona formularios que no están en el repo: ${fantasmas.join(', ')} — los ignoro acá (los juzga la validación de la deuda)`);
    }
    porDeuda.push(...d.forms.filter((f) => forms.includes(f)));
    if (porDeuda.length) {
      console.error(`[afectados] cambió la declaración de deuda de: ${porDeuda.join(', ')} — se suman a lo que hay que probar`);
    }
  }

  const soloNeutros = cambiados.every((c) => NO_AFECTAN.some((rx) => rx.test(c)));
  if (soloNeutros && !porDeuda.length) {
    console.error(`[afectados] el cambio toca sólo archivos que no afectan a ningún formulario (${cambiados.slice(0, 3).join(', ')}) — no hay nada que probar ni construir`);
    return 0;
  }
  if (soloNeutros) {
    console.error('[afectados] fuera de la declaración de deuda, el cambio no toca ningún formulario');
  }

  const compartido = cambiados.find((c) => esCompartido(c, forms));
  if (compartido) {
    console.error(`[afectados] cambió algo fuera de los formularios (${compartido}) — afecta a TODOS`);
    console.log(forms.join('\n')); return 0;
  }

  const directos = [...new Set([...cambiados.map((c) => c.split('/')[0]).filter((f) => forms.includes(f)), ...porDeuda])];
  const todos = conDependientes(g, directos);
  const porDependencia = [...todos].filter((f) => !directos.includes(f)).sort();
  if (porDependencia.length) {
    console.error(`[afectados] a probar por cambio propio o por su deuda: ${directos.sort().join(', ')}; se suman por dependencia: ${porDependencia.join(', ')}`);
  } else {
    console.error(`[afectados] a probar por cambio propio o por su deuda: ${directos.sort().join(', ')}; nadie más depende de ellos`);
  }
  console.log([...todos].sort().join('\n'));
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { formularios, grafo, conDependientes, esCompartido, declaraciones, deltaDeDeuda };
