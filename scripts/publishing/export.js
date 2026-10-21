#!/usr/bin/env node
'use strict';
// export.js — la clasificación de lo que el arnés publica
//
// POR QUÉ EXISTE: el repo público es la fuente del arnés y nadie arma una copia. Este guion queda como CONTROL: clasifica
// qué publicaría cada commit (la lista blanca, las exclusiones fijas, las transformaciones con nombre) y verifica.
// Pedirle una copia sale 2 diciéndolo.
//
// QUEDA EL CONTROL, que sigue haciendo falta mientras exista el repo de mantenimiento del equipo:
//   · `--explain`: el primer nivel de cada fuente clasificado (qué entra, qué queda afuera y por qué), las exclusiones
//     fijas y su cobertura. Una entrada sin clasificar o una exclusión que ya no cubre nada se marcan con 🛑.
//   · la clasificación como biblioteca (`whatShips` y lo que la rodea): qué publica un commit y con qué contenido. La
//     usan el freno de nombres nuevos (new-names.js), el control de historia interna, el reparto del repo de
//     mantenimiento y el instalador (la capa del equipo).
//   · los lectores que comparten otros guiones: el nombre público (`readPublicRepo`), el git aislado, los objetos de git.
//
// CÓMO FALLA: exit 0 = clasificado · 2 = no pude clasificar (configuración, referencia, repo) o me pidieron armar una
// copia. «No pude mirar» nunca es «limpio». No se llama a ningún servicio: sólo git local y archivos.
//
// A mano:
//   node scripts/publishing/export.js --explain [--json]
//        [--harness <ref>] [--agent-skills <ref>]  (default origin/main · repos: TYCON_GUIDES_DIR y TYCON_SKILLS_DIR)
//        [--allowlist <f>] [--replacements <f>] [--denied <f>] [--public-repos <f>]   (default: los de scripts/publishing/)
// Guía: guides/maintaining/publicacion-espejo.md

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
// el detector, los frenos de nombres y la configuración (lista blanca, tabla, lista de denegación) viven al lado de este guion
const detector = require('./detector.js');
// las funciones puras de la copia pública: bloques internos, enlaces, rutas del README, atribuciones, el
// renombre de una skill y la poda del manifiesto de terceros. Acá se cablean; la lógica vive allá, con su prueba. Se
// carga recién cuando se usa: quien sólo pide la clasificación o un lector (el freno de nombres en un laboratorio con
// algunos guiones copiados) no lo necesita.
let publicCopyModule = null;
const publicCopy = new Proxy({}, { get: (_, k) => (publicCopyModule || (publicCopyModule = require('./public-copy.js')))[k] });

const RAIZ_PROPIA = path.resolve(__dirname, '..', '..');
const FUENTES = Object.freeze(['arnes', 'agent-skills']);
// Los paquetes se llaman en inglés (`core`, `clients`). El nombre viejo de cada uno lo sigue aceptando
// `--package` (lo traduce el alias al entrar) y lo lee `paquetesConNombresNuevos` en una lista blanca de antes del
// renombre. Los viejos salen del mapa de renombres, nunca escritos acá; sin mapa (la copia pública), no hay viejos.
const MAPA_WHERE = 'scripts/publishing/export.js';
function nombresViejosDePaquete() {
  try {
    const ln = require('../lib/legacy-names.js');
    return ln.usableEntries(ln.loadMap()).filter((e) => e.kind === 'value' && e.where === MAPA_WHERE && e.option === 'package'
      && typeof e.old === 'string' && typeof e.new === 'string');
  } catch (_) {
    return [];
  }
}
// El privado acepta los dos nombres: la carpeta de su manifiesto en agent-skills (packs/<nombre>)
// todavía tiene el viejo, y es por esa carpeta que se sabe qué revisores son suyos.
const PAQUETES_PRIVADOS = Object.freeze(['clients', ...nombresViejosDePaquete().filter((e) => e.new === 'clients').map((e) => e.old)]);
/** La lista blanca con los paquetes por su nombre nuevo: una de antes del renombre (la foto de antes del freno de nombres
 *  nuevos) nombra el mismo paquete con el viejo, y compararla con la de después tiene que ver UN paquete, no dos. Espera
 *  las claves actuales: una lista de otra versión del arnés pasa antes por `readKeysDeep`. */
function paquetesConNombresNuevos(lista) {
  if (!lista || typeof lista !== 'object' || !lista.packages || typeof lista.packages !== 'object') return lista;
  const viejos = nombresViejosDePaquete().filter((e) => Object.prototype.hasOwnProperty.call(lista.packages, e.old)
    && !Object.prototype.hasOwnProperty.call(lista.packages, e.new));
  if (!viejos.length) return lista;
  const paquetes = {};
  for (const [k, v] of Object.entries(lista.packages)) {
    const e = viejos.find((x) => x.old === k);
    paquetes[e ? e.new : k] = v;
  }
  return { ...lista, packages: paquetes };
}
// Las categorías de `denylist.json` (más las que declare la lista): una categoría inventada en la tabla es un error.
const CATEGORIAS = Object.freeze(['cliente', 'persona', 'host-interno', 'maquina', 'interno']);
const MARCAS = Object.freeze(['tycon', 'bizuit']);
// Un anónimo que se aplica fuera de `.md` va a parar a código, claves y variables: sin espacios ni puntuación rara
// («Cliente A» rompería 3 `.js` y dos suites). Salvo que su forma tenga esos mismos signos, en el mismo orden:
// `org: 'x'` → `org: 'y'` conserva la forma y no rompe nada; `Totora` → `Cliente A`
// agrega un espacio donde no había y sigue rechazado.
const ANONIMO_SEGURO = /^[A-Za-z0-9._/:@-]+$/;
const signosRaros = (s) => (s.match(/[^A-Za-z0-9._/:@-]/g) || []).join('');
const anonimoAceptable = (texto, anonimo) => ANONIMO_SEGURO.test(anonimo) || signosRaros(anonimo) === signosRaros(texto);
const AUTOR = Object.freeze({ nombre: 'TYCON', email: 'arnes@tycon.com.ar' });
// El repo público es la fuente y nadie arma una copia. El exportador es un CONTROL: clasifica (`--explain`, y `whatShips` para los frenos y el instalador) y verifica; pedirle una copia
// sale 2 con este motivo.
const NO_ARMA = 'ya no arma la copia: el repo público es la fuente (story 8.26, AC 36). Lo que queda es el control: --explain clasifica, y los frenos y el instalador leen la clasificación como biblioteca';
// El nombre público vive en UN archivo, que lee sólo el exportador (y la sincronización) y
// que no viaja: la copia lleva el nombre ya puesto en sus papeles
const PUBLIC_REPOS = 'scripts/publishing/public-repos.json';
// Los archivos que pueden escribir la dirección del repo público («<org>/<repo>» o su URL de GitHub), cada uno con su
// motivo. Vive al lado del nombre (en el repo de mantenimiento) y la lee readPublicNameExceptions: la prueba del nombre
// y quien la necesite leen lo mismo.
const PUBLIC_NAME_EXCEPTIONS = 'scripts/publishing/public-name-exceptions.json';
const PUBLIC_NAME_OK = /^[A-Za-z0-9._-]+$/;
const PUBLIC_MARKER = /\{\{public-[^}]*\}\}/g;
// La versión numerada de la copia. Es un archivo GENERADO —no sale de ninguna fuente— y la lista
// blanca lo declara en `generated`. Sus bytes los arma una sola función (`versionFileBytes`): la usan la opción
// --stamp-version, para una copia suelta, y la sincronización (mirror.js), que lo agrega cuando ya leyó el público.
const VERSION_FILE = 'version.json';
const VERSION_SHAPE = /^\d{4}\.(?:0[1-9]|1[0-2])\.(?:0[1-9]|[12]\d|3[01])\.[1-9]\d*$/;
// las fuentes de `source`, en el orden en que se escriben; una que no esté acá va después, por código
const VERSION_SOURCES = Object.freeze(['harness', 'agent_skills']);
const VERSION_SOURCE_NAME = /^[a-z][a-z0-9_]*$/;
// los generados que este exportador sabe armar: uno declarado en la lista que no esté acá no lo genera nadie
const GENERATED_FILES = Object.freeze([VERSION_FILE]);
const MANIFIESTO_TERCEROS = 'scripts/publishing/third-party-skills.json';
const CODEX_TOML = /^arnes\/adapters\/codex\/agents(?:-native)?\/[^/]+\.toml$/;
const MANIFIESTO_CODEX = 'adapters/codex/agents/MANIFEST.json';
const CATALOGO = 'guides/advisor-rules-catalog.md';
const REGISTRO_DE_PARTES = 'scripts/tests/suite-parts.json';   // las suites partidas: ver la transformación suite-parts-json
const LINEA_BASE = /^scripts\/controls-bench\/baseline\/[^/]+\.json$/;

// Lo privado de la publicación con el nombre que tuvo antes de la mudanza: una clase por cada
// nombre viejo del mapa, en las dos fuentes, así una foto de antes de la mudanza (la base de un freno con --range, un
// --harness viejo) tampoco lo deja salir. Los viejos salen del mapa, nunca escritos acá; sin mapa (la copia pública) no
// hay viejos, y tampoco archivos privados que proteger.
const PRIVADOS = Object.freeze({
  'scripts/publishing/denylist.json': 'la lista de denegación',
  'scripts/publishing/replacements.json': 'la tabla de reemplazos',
});
function privadosConNombreViejo() {
  try {
    const ln = require('../lib/legacy-names.js');
    const globs = [];
    for (const e of ln.usableEntries(ln.loadMap())) {
      if (e.kind !== 'file' || !Object.prototype.hasOwnProperty.call(PRIVADOS, e.new) || typeof e.old !== 'string') continue;
      const raiz = path.posix.basename(e.old).replace(/\.json$/, '');
      if (!raiz || raiz === path.posix.basename(e.new).replace(/\.json$/, '')) continue;
      for (const fuente of FUENTES) {
        globs.push({ fuente, glob: `**/${raiz}*.json`, motivo: `lo privado de la publicación: ${PRIVADOS[e.new]}, con su nombre de antes de la story 8.9`, clase: true });
      }
    }
    return globs;
  } catch (_) {
    return [];
  }
}
// El registro de productos (lo lee también el freno de nombres nuevos). Una foto de
// antes de la mudanza (un --harness viejo, la base de un freno) lo tiene en su ruta vieja, que sale del mapa — nunca escrita acá.
const PARIDAD = 'scripts/ci/product-parity.json';
/** Las rutas viejas (del mapa) de un archivo del arnés; sin mapa (la copia pública), ninguna. */
function rutasViejasDe(ruta) {
  try {
    const ln = require('../lib/legacy-names.js');
    return ln.usableEntries(ln.loadMap()).filter((e) => e.kind === 'file' && (e.repo || 'arnes') === 'arnes' && e.new === ruta
      && typeof e.old === 'string' && e.old !== ruta).map((e) => e.old);
  } catch (_) {
    return [];
  }
}
/** Una exclusión fija con el nombre que tuvo antes de la mudanza, como clase (no se le exige archivo): así una foto de
 *  antes de la mudanza tampoco lo deja salir. */
function fijasConNombreViejo(fijas) {
  return fijas.flatMap((x) => rutasViejasDe(x.glob).map((viejo) => ({ fuente: x.fuente, glob: viejo, motivo: `${x.motivo}, con su nombre de antes de la story 8.9`, clase: true })));
}
// La carpeta del nocturno de dependencias, con su ruta de antes de la mudanza. Esa ruta cae bajo un «in»
// (`scripts/**`) y guarda la lista de repos del equipo: una foto de antes de la mudanza (un --harness viejo, la base de
// un freno) la trae ahí, y sin una exclusión por esa ruta saldría en la copia. Queda como clase —sólo tiene reemplazos:
// no se le exige archivo— hasta el retiro del mapa; la ruta vieja sale del mapa, nunca escrita acá.
// Las otras carpetas movidas vivían en la raíz, fuera de todo «in»: una foto vieja las trae como entradas del primer
// nivel sin clasificar y la exportación sale 2 sin escribir nada (no hace falta una clase para ellas).
const NOCTURNO_DEPENDENCIAS = { fuente: 'arnes', glob: 'scripts/nightly/dependencies/**', motivo: 'la revisión nocturna de dependencias del equipo' };
// La validación de cada pedido y sus plantillas son del repo privado, y ninguna ruta de `pipelines/` fuera de los modelos de operaciones viaja. Rutas exactas,
// nunca un glob: lo que no está nombrado acá sigue bajo la exclusión fija.
const VALIDACION_PUBLICA = Object.freeze([]);
// Los modelos de los pipelines de operaciones que el arnés le da a cada organización: la carpeta existe SÓLO en el repo
// público (el privado no tiene pipelines/operations/; los pipelines vivos del equipo están en su repo de operaciones),
// así que todo lo que hay ahí ya es público por construcción. Es la única carpeta del `salvo`: sin ella, una guía pública
// que cita un modelo cuenta como ruta del equipo (el control de historia interna de la paridad sale rojo).
const MODELOS_DE_OPERACIONES = 'pipelines/operations/**';
/** ¿El `salvo` de una exclusión fija nombra esa ruta? Un archivo por su nombre; la carpeta de los modelos, por su glob. */
const enSalvo = (x, ruta) => (x.salvo || []).some((s) => (s === MODELOS_DE_OPERACIONES ? coincide(s, ruta) : s === ruta));
/** ¿La exclusión fija cubre ese archivo? Su glob, menos lo que nombra su `salvo`. */
const cubreFija = (x, ruta) => coincide(x.glob, ruta) && !enSalvo(x, ruta);
/** Las carpetas viejas (del mapa) de una carpeta del arnés; sin mapa (la copia pública), ninguna. */
function carpetasViejasDe(carpeta) {
  try {
    const ln = require('../lib/legacy-names.js');
    return ln.usableEntries(ln.loadMap()).filter((e) => e.kind === 'folder' && (e.repo || 'arnes') === 'arnes' && e.new === carpeta
      && typeof e.old === 'string' && e.old && e.old !== carpeta).map((e) => e.old);
  } catch (_) {
    return [];
  }
}
/** Una exclusión fija de carpeta (`<carpeta>/**`) con la ruta que tuvo antes de la mudanza, como clase. */
function carpetasFijasConNombreViejo(fijas) {
  return fijas.flatMap((x) => carpetasViejasDe(x.glob.replace(/\/\*\*$/, '')).map((vieja) => ({ fuente: x.fuente, glob: `${vieja}/**`, motivo: `${x.motivo}, con su nombre de antes de la story 8.9`, clase: true })));
}

// ── Exclusiones fijas: nunca salen, cubra lo que cubra «in» ──────────────────────────────────────────────────
// Por fuente y con su motivo. Una `clase` protege una familia de archivos que hoy puede no tener ninguno (no se le
// exige archivo); las demás, si caen bajo un glob de «in» en uso, TIENEN que coincidir con algún archivo del sha:
// así un renombre no publica en silencio lo que antes quedaba afuera.
const EXCLUIDOS_SIEMPRE = Object.freeze([
  { fuente: 'arnes', glob: '.engram/**', motivo: 'la memoria del equipo (engram): decisiones y casos nominados' },
  { fuente: 'arnes', glob: '.dashboard/**', motivo: 'series del medidor y tableros de las máquinas del equipo' },
  { fuente: 'arnes', glob: '.advisors/**', motivo: 'evidencia de las corridas del pipeline sobre este repo' },
  // el buzón de decisiones del equipo: `inbox/instincts/`, `inbox/watcher/` (los hallazgos de la mirada nocturna de la
  // producción) e `inbox/dependencies/` (las fichas de vulnerabilidades de los repos del equipo)
  { fuente: 'arnes', glob: 'inbox/**', motivo: 'el buzón de decisiones del equipo: instintos minados de sus sesiones y lo que espera que alguien decida' },
  { fuente: 'arnes', glob: 'tasks/**', motivo: 'planes, auditorías y mediciones internas' },
  { fuente: 'arnes', glob: 'specs/**', motivo: 'las stories del arnés: casos nominados con fecha' },
  { fuente: 'arnes', glob: 'qa/**', motivo: 'las guías de prueba de las stories del arnés' },
  { fuente: 'arnes', glob: '_bmad/**', motivo: 'la configuración de BMAD del equipo' },
  { fuente: 'arnes', glob: 'guides/maintaining/incident-log.md', motivo: 'los incidentes del equipo, con casos nominados' },
  { fuente: 'arnes', glob: 'guides/guide-update-proposals.md', motivo: 'propuestas internas sobre las guías' },
  // el inventario vive con los documentos fechados de decisiones; la exclusión sigue al archivo (el
  // reemplazo que queda en la ruta vieja no la cubre: si la guía se vuelve a mover sin su glob, la exportación sale 2)
  { fuente: 'arnes', glob: 'guides/decisions/telemetria-produccion-inventario-*.md', motivo: 'inventario de la producción de un cliente' },
  { fuente: 'arnes', glob: 'scripts/metrics/censo-*.json', motivo: 'censos fechados de los repos del equipo' },
  { fuente: 'arnes', glob: PARIDAD, motivo: 'los productos de los clientes y dónde viven' },
  { fuente: 'arnes', glob: 'scripts/ci/pipeline-debt.json', motivo: 'la deuda de pipelines por repo de cliente (la copia lleva un sintético)' },
  { fuente: 'arnes', glob: 'scripts/metrics/corridas-buzon.json', motivo: 'la llave del buzón de corridas del equipo' },
  // el perfil con su nombre actual y el anterior, que sigue valiendo: el clon tiene uno de los dos (o, en la transición,
  // los dos), así que a ninguno se le exige archivo (`clase`)
  { fuente: 'arnes', glob: 'team-profile.json', motivo: 'el perfil del equipo: organización e integraciones', clase: true },
  { fuente: 'arnes', glob: 'perfil-equipo.json', motivo: 'el perfil del equipo, con su nombre de antes (sigue valiendo)', clase: true },
  // los yml de los pipelines y su plantilla viven en `pipelines/`, una sola exclusión
  // `salvo` la validación y sus plantillas, que viven en el repo público (Azure sólo valida un pedido de GitHub si el
  // YAML está en ese repo) y viajan, así el detector y el freno de nombres de cada publicación las miran. La lista es cerrada y con nombre: un pipeline nuevo queda afuera solo.
  { fuente: 'arnes', glob: 'pipelines/**', motivo: 'los pipelines del equipo en Azure DevOps y la plantilla que trae sus repos', salvo: [...VALIDACION_PUBLICA, MODELOS_DE_OPERACIONES], motivoSalvo: 'los modelos de los pipelines de operaciones, que sólo existen en el repo público (la validación de cada pedido y sus plantillas son del repo privado desde la story 8.41)' },
  // el ejecutable y sus dos .json viven acá; la exclusión sigue al archivo. La carpeta vieja (sólo reemplazos) queda
  // excluida como clase, al final de esta lista: `carpetasFijasConNombreViejo`
  // el código de los dos nocturnos —dependencias y vigilante— es público.
  // Del equipo queda sólo la lista de sus repos, en el repo de mantenimiento: como clase (el público no la trae)
  { fuente: 'arnes', glob: 'scripts/nightly/dependencies/repos.json', motivo: NOCTURNO_DEPENDENCIAS.motivo, clase: true },
  { fuente: 'arnes', glob: 'commands/tycon-vigilante.md', motivo: 'su sujeto (el vigilante) no viaja' },
  { fuente: 'arnes', glob: 'scripts/controls-bench/ultimo-*.json', motivo: 'resultados de las corridas del equipo' },
  { fuente: 'arnes', glob: '**/denylist*.json', motivo: 'lo privado de la publicación: la lista de denegación' },
  { fuente: 'arnes', glob: '**/replacements*.json', motivo: 'lo privado de la publicación: la tabla de reemplazos' },
  { fuente: 'arnes', glob: 'scripts/lib/renames.json', motivo: 'el mapa de renombres a inglés (story 8.9): los nombres viejos no viajan; sin él, legacy-names.* es paso directo', clase: true },
  { fuente: 'agent-skills', glob: 'skills/projects/**', motivo: 'las skills de los proyectos de clientes' },
  { fuente: 'agent-skills', glob: 'skills/infrastructure/**', motivo: 'la infraestructura de la empresa' },
  { fuente: 'agent-skills', glob: '**/denylist*.json', motivo: 'lo privado de la publicación: la lista de denegación', clase: true },
  { fuente: 'agent-skills', glob: '**/replacements*.json', motivo: 'lo privado de la publicación: la tabla de reemplazos', clase: true },
  ...privadosConNombreViejo(),
  ...fijasConNombreViejo([{ fuente: 'arnes', glob: PARIDAD, motivo: 'los productos de los clientes y dónde viven' }]),
  ...carpetasFijasConNombreViejo([NOCTURNO_DEPENDENCIAS]),
]);

// ── Transformaciones con nombre (las lista --explain; cada ajuste queda en el listado de la corrida) ─────────
const TRANSFORMACIONES = Object.freeze([
  { nombre: 'revisores-de-paquete', que: 'un revisor de un paquete sale entero o no sale: en el núcleo no va ninguna superficie suya (su .md, sus traducciones a Codex, sus casos del banco); en su paquete va el .md y el resto queda en «pendientes»' },
  { nombre: 'manifiesto-codex', que: `${MANIFIESTO_CODEX}: se sacan los revisores que no salen, con el orden y el formato del resto` },
  { nombre: 'linea-base-banco', que: 'scripts/controls-bench/baseline/*.json: se sacan las entradas «<revisor>::*» de los revisores que no salen' },
  { nombre: 'catalogo-de-reglas', que: `${CATALOGO}: se saca la sección de cada revisor que no sale (de su encabezado «## … — \`<revisor>\`» al siguiente «## »)` },
  { nombre: 'suites-json', que: 'scripts/tests/suites.json: se saca la entrada de toda suite cuyo archivo no sale o que la lista declara en suitesOutside' },
  { nombre: 'suite-parts-json', que: `${REGISTRO_DE_PARTES}: se saca la entrada de toda suite partida cuyo archivo entero no sale o que la lista declara en suitesOutside (story 8.22)` },
  { nombre: 'suites-y-casos-fuera', que: 'allowlist.json → suitesOutside / casesOutside: la suite (o el caso del banco) y su entrada salen juntas' },
  { nombre: 'vaciar', que: 'allowlist.json → empty: la clave declarada queda vacía y el resto del archivo igual (una ruta con puntos, «a.b», llega a una clave anidada; story 8.10.3)' },
  { nombre: 'public-texts', que: 'allowlist.json → publicTexts: en el archivo declarado, el texto EXACTO del repo (puede ocupar varios renglones) pasa a su versión pública, las veces declaradas; si no aparece esas veces, sale 2. Para los textos de código que mandan a una integración del equipo que no viaja: los bloques internos sólo existen en los .md' },
  { nombre: 'sinteticos', que: 'allowlist.json → synthetic: el archivo de la copia es el sintético declarado; con «packages», en las exportaciones que incluyen alguno de ellos; sin él, cuando un «in» del paquete cubre el destino. Nunca pisa algo que ya sale (sale 2)' },
  { nombre: 'gitignore-publico', que: '.gitignore de cada repo: se quitan las líneas «!…» que vuelven a incluir algo de una exclusión fija; con --single-repo, además se ignora cada carpeta de primer nivel del repo fuente en la que la copia no trae ningún archivo (story 8.26); una que sólo difiere en mayúsculas de una que la copia trae, o con un salto de línea en el nombre, frena la copia' },
  { nombre: 'nombres-viejos', que: 'scripts/lib/renames.json (story 8.9): el reemplazo de cada ruta vieja de archivo o carpeta no sale; y un archivo que sale no puede nombrar una ruta vieja (fuera de guides/maintaining/nombres-en-ingles.md)' },
  { nombre: 'rutas-del-otro-repo', que: 'scripts/lib/renames.json (story 8.9, AC 19): la ruta vieja ya mudada que un repo nombra del OTRO se traduce al nombre nuevo (la copia sale de los dos repos juntos); la que un repo nombra de sí mismo frena la copia. Un reemplazo generado sin entrada en el mapa que algo que sale nombra sale 2 (story 8.7, AC 30)' },
  { nombre: 'traducciones-codex', que: 'adapters/codex/agents*/*.toml: se REGENERAN con build/generate.js desde los .md ya reemplazados (no se reemplazan); la que queda distinta de su blob va al listado' },
  { nombre: 'skill-rename', que: 'allowlist.json → skillRenames: la skill sale con otro nombre — su carpeta, el name: de su SKILL.md y el identificador en cada archivo de texto que sale —, salvo el NOTICE, el NOTICE.md y el LICENSE de su carpeta y, en el manifiesto de terceros, based_on y license_source (su why pasa al texto fijo de la regla)' },
  { nombre: 'public-third-party', que: `${MANIFIESTO_TERCEROS}: en third_party quedan sólo las «download» con licencia MIT o Apache-2.0 que usa algo que sale (directa o indirectamente) o que traen publish: true; own, derived y el resto, byte a byte` },
  { nombre: 'not-in-copy', que: 'todo .md que sale (con el núcleo; salvo el README y el INSTALL de la raíz): una ruta entre comillas invertidas, en prosa, que existe en el repo del equipo y no en la copia lleva al lado la marca de public-copy.js (NOT_IN_COPY_MARK). No se marcan las convenciones del repo del lector (allowlist.json → readerConventions), las anclas al registro de incidentes ni lo que está dentro de un cerco. Va después de internal-blocks y antes de los reemplazos y de regenerar las traducciones a Codex' },
  { nombre: 'internal-blocks', que: 'todo .md: sale el bloque interno con sus marcadores y queda visible el sólo-público sin los suyos; un marcador sin par, anidado, en un cerco, entre dos filas de una tabla o fuera de un .md sale 2' },
  { nombre: 'public-name', que: `los sintéticos: {{public-org}} y {{public-repo}} pasan al nombre público de ${PUBLIC_REPOS} (o --public-repos); otro {{public-…}} sale 2` },
  { nombre: 'merged-gitignore', que: '--single-repo: el .gitignore de la copia son las líneas de los dos, primero las del arnés, sin repetir. Desde el repo unido (story 8.18) no hace nada: el .gitignore ya es uno y sale como está' },
  // el repo unido en la copia de dos repos
  { nombre: 'split-hooks', que: 'sin --single-repo, desde un commit del repo unido que trae el pre-commit partido en dos (pre-commit-harness, pre-commit-skills): cada parte vuelve a ser el .githooks/pre-commit del repo de su fuente, y el despachador no sale (en dos repos llamaría a una parte que quedó en el otro). Con el control único (.githooks/pre-commit-checks) no hay nada que partir: sale como está' },
  { nombre: 'generated', que: `allowlist.json → generated: un archivo que no sale de ninguna fuente. Hoy ${VERSION_FILE}: con --stamp-version <YYYY.MM.DD.N> (sólo con --single-repo) la copia lo trae en su raíz, con ese número y el commit de cada fuente; sin la opción la copia no cambia, y en la sincronización lo agrega mirror.js con la misma función. Una fuente o un sintético que ya trae ese destino sale 2` },
]);

// ── Controles de la copia: cada uno, una clave de «controles» en el --json; un hallazgo es exit 1 (los lista --explain) ─
const COPY_CONTROLS = Object.freeze([
  { nombre: 'nombresPegados', que: 'un nombre de la lista de denegación pegado a otro identificador, que el borde de palabra deja pasar (en el texto y en las rutas)' },
  { nombre: 'compilacion', que: 'cada .js, .sh y .py de la copia compila' },
  { nombre: 'comandosColgados', que: 'un comando de una skill o de un comando del arnés que manda correr algo que no viaja' },
  { nombre: 'nombresViejos', que: 'una ruta vieja del mapa de renombres que un archivo que sale nombra de su propio repo' },
  { nombre: 'links', que: 'un enlace relativo de Markdown (fuera de un cerco o de código en línea) a algo que no está en la copia' },
  { nombre: 'readmePaths', que: 'una ruta entre comillas invertidas del README.md o el INSTALL.md del arnés que empieza con una entrada de primer nivel de las fuentes (salvo .tycon/) y no está en la copia' },
  // su propia cuenta, sin la función de la marca
  { nombre: 'pathsNotInCopy', que: 'una ruta entre comillas invertidas de un .md que sale (fuera de un cerco; salvo el README y el INSTALL de la raíz, las convenciones del repo del lector y las anclas al registro) que existe en el repo del equipo y no en la copia, y no lleva la marca al lado' },
  { nombre: 'attributions', que: `el NOTICE nombra («* <ruta>») cada derived de ${MANIFIESTO_TERCEROS} que sale, y nada que no salga` },
  { nombre: 'skillRenameLeft', que: 'el nombre viejo de una skill renombrada que quedó en la copia, fuera de sus excepciones' },
  { nombre: 'handWrittenPublicUrl', que: 'un papel (el from de un sintético) que escribe a mano la URL del repo público en vez de {{public-org}}/{{public-repo}}' },
]);

class NoPudo extends Error {
  constructor(motivo, extra = {}) {
    super(motivo);
    this.extra = extra;
  }
}

// ── Utilidades ───────────────────────────────────────────────────────────────────────────────────────────────
const porCodigo = (a, b) => (a < b ? -1 : a > b ? 1 : 0);   // unidades de código: no depende de LANG
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// La ruta canónica, con la caja que tiene en el disco: en uno que no distingue mayúsculas, `ARNES` y `arnes` son la
// misma carpeta y la comparación de contención tiene que verlas iguales. «No existe» es null; cualquier otro error
// (un permiso, un enlace que se muerde la cola) es «no pude mirar», nunca «no existe».
function real(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new NoPudo(`no pude resolver la ruta ${p} (${(e && e.code) || e})`);
  }
}
const dentroDe = (hijo, padre) => hijo === padre || hijo.startsWith(`${padre}${path.sep}`);
const esMarca = (s) => MARCAS.includes(String(s == null ? '' : s).trim().toLowerCase());
const corto = (sha) => String(sha).slice(0, 12);

/**
 * Aplica a `contenido` (el archivo `clave`, «<fuente>/<ruta>») cada entrada de `publicTexts` que lo
 * nombra: el texto exacto pasa a su versión pública. Si una entrada no aparece exactamente `count` veces, tira NoPudo
 * (un texto que cambió en la fuente no se deja pasar en silencio: la copia volvería a decir lo del equipo).
 */
function applyPublicTexts(clave, contenido, entradas) {
  let out = contenido;
  for (const e of entradas || []) {
    if (`${e.root}/${e.file}` !== clave) continue;
    const n = out.split(e.text).length - 1;
    if (n !== e.count) {
      throw new NoPudo(`publicTexts: ${e.root}:${e.file} trae ${n} vez/veces el texto declarado y la lista dice ${e.count} — ¿cambió la fuente? (${e.reason})`);
    }
    out = out.split(e.text).join(e.public);
  }
  return out;
}

/**
 * Los bytes de `version.json`: `{ version, source }`, con `source` un mapa de fuente → commit. Las
 * fuentes son `harness` y `agent_skills`; la función escribe las que le den y no las cuenta. No lleva la fecha de la
 * corrida ni el canal: la misma entrada da los mismos bytes en cualquier máquina y cualquier día. Las claves van en
 * orden fijo —las de VERSION_SOURCES primero, el resto por código—, con dos espacios de sangría y un salto de línea al
 * final. Lo que no tiene forma tira (NoPudo): no hay archivo a medias.
 *
 * Con `transformed` —las rutas PUBLICADAS cuyo blob difiere del interno, cada una con el nombre de
 * su ajuste (`transformedList`)— la escribe después de `source`, ordenada por ruta, cada entrada sólo con `path` y
 * `transform`. Sin `transformed` no la escribe.
 */
function versionFileBytes({ version, source, transformed } = {}) {
  if (typeof version !== 'string' || !VERSION_SHAPE.test(version)) {
    throw new NoPudo(`${VERSION_FILE}: la versión ${JSON.stringify(version === undefined ? null : version)} no tiene la forma YYYY.MM.DD.N (N desde 1, sin ceros adelante)`);
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new NoPudo(`${VERSION_FILE}: "source" es un mapa de fuente a commit`);
  const nombres = Object.keys(source);
  if (!nombres.length) throw new NoPudo(`${VERSION_FILE}: "source" no trae ninguna fuente`);
  for (const n of nombres) {
    if (!VERSION_SOURCE_NAME.test(n)) throw new NoPudo(`${VERSION_FILE}: «${n}» no es el nombre de una fuente (minúsculas, números y _)`);
    if (typeof source[n] !== 'string' || !/^[0-9a-f]{40,64}$/.test(source[n])) throw new NoPudo(`${VERSION_FILE}: el commit de «${n}» no es un sha completo`);
  }
  const enOrden = [...VERSION_SOURCES.filter((n) => nombres.includes(n)), ...nombres.filter((n) => !VERSION_SOURCES.includes(n)).sort(porCodigo)];
  const datos = { version, source: Object.fromEntries(enOrden.map((n) => [n, source[n]])) };
  if (transformed !== undefined) datos.transformed = transformedEntries(transformed);
  return Buffer.from(`${JSON.stringify(datos, null, 2)}\n`, 'utf8');
}

/** La lista `transformed`, validada y en orden por ruta. Lo que no tiene forma tira: no hay archivo a medias. */
function transformedEntries(transformed) {
  if (!Array.isArray(transformed)) throw new NoPudo(`${VERSION_FILE}: "transformed" es una lista de { path, transform }`);
  const vistas = new Set();
  for (const t of transformed) {
    if (!t || typeof t !== 'object' || Array.isArray(t) || Object.keys(t).some((k) => k !== 'path' && k !== 'transform')) {
      throw new NoPudo(`${VERSION_FILE}: cada entrada de "transformed" trae sólo "path" y "transform"`);
    }
    if (typeof t.path !== 'string' || !t.path || t.path.startsWith('/') || t.path === VERSION_FILE) {
      throw new NoPudo(`${VERSION_FILE}: "transformed" trae una entrada sin una ruta publicada (relativa, y que no sea ${VERSION_FILE})`);
    }
    if (typeof t.transform !== 'string' || !t.transform.trim()) throw new NoPudo(`${VERSION_FILE}: la ruta ${JSON.stringify(t.path)} de "transformed" no trae el nombre de su transformación`);
    if (vistas.has(t.path)) throw new NoPudo(`${VERSION_FILE}: la ruta ${JSON.stringify(t.path)} está dos veces en "transformed"`);
    vistas.add(t.path);
  }
  return transformed.map((t) => ({ path: t.path, transform: t.transform })).sort((a, b) => porCodigo(a.path, b.path));
}

/**
 * Ruta → blob de los árboles internos (sólo archivos), en el orden dado: una ruta que traen dos (el `.gitignore` con dos
 * repos físicos) es la del primero. Con el repo unido, los dos árboles son las dos mitades de uno, y no se pisan.
 */
function internalBlobs(arboles) {
  const mapa = new Map();
  for (const arbol of arboles) for (const e of arbol) if (e.tipo === 'blob' && !mapa.has(e.ruta)) mapa.set(e.ruta, e.obj);
  return mapa;
}

function leerJson(ruta, que) {
  let crudo;
  try {
    crudo = fs.readFileSync(ruta, 'utf8');
  } catch (e) {
    throw new NoPudo(`no pude leer ${que} ${ruta} (${e.code || e.message})`);
  }
  try {
    return JSON.parse(crudo);
  } catch (e) {
    throw new NoPudo(`${que} ${ruta} no es JSON válido (${e.message})`);
  }
}

// ── git, aislado de la máquina ─────────────────────────────────────────────────────────────────────────────
// Sin las variables GIT_* heredadas (un hook de git deja GIT_DIR/GIT_INDEX_FILE puestas y redirigirían todo), sin
// la configuración global ni la de sistema, y sin atributos, autocrlf ni hooks.
const AMBIENTE_GIT = (() => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
})();
const GIT_AISLADO = ['-c', 'core.autocrlf=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.hooksPath=/dev/null'];

function git(dir, args, { input, env, binario } = {}) {
  const opciones = { env: env ? { ...AMBIENTE_GIT, ...env } : AMBIENTE_GIT, maxBuffer: 1024 * 1024 * 1024 };
  // Con salida binaria la entrada va como Buffer: spawnSync codifica una entrada de texto con `encoding`.
  if (binario) opciones.input = input === undefined ? undefined : Buffer.from(input, 'utf8');
  else Object.assign(opciones, { input, encoding: 'utf8' });
  const r = spawnSync('git', ['-C', dir, ...GIT_AISLADO, ...args], opciones);
  if (r.error) throw new NoPudo(`no pude correr git ${args[0]} (${r.error.code || r.error.message})`);
  return r;
}

function salidaGit(dir, args, opts = {}) {
  const r = git(dir, args, opts);
  if (r.status !== 0) throw new NoPudo(`git ${args.join(' ')} falló en ${dir}: ${String(r.stderr).trim()}`);
  return r.stdout;
}

// ── Globs: los del detector (`**` cruza carpetas, `*` y `?` no), más la intersección ─────────────────────────
const normalizar = (g) => (g.endsWith('/') ? `${g}**` : g);
const regexes = new Map();
function coincide(glob, ruta) {
  let r = regexes.get(glob);
  if (!r) {
    r = detector.globARegex(normalizar(glob));
    regexes.set(glob, r);
  }
  return r.test(ruta);
}

/** ¿Hay un texto sin «/» que cumplan los dos patrones de segmento? (`*` = cualquier tira, `?` = un carácter) */
function segmentosIntersectan(p, q) {
  const vistos = new Set();
  const pila = [[0, 0]];
  while (pila.length) {
    const [i, j] = pila.pop();
    const k = `${i},${j}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    if (i === p.length && j === q.length) return true;
    if (p[i] === '*') pila.push([i + 1, j]);
    if (q[j] === '*') pila.push([i, j + 1]);
    if (i < p.length && j < q.length) {
      const a = p[i];
      const b = q[j];
      if (a === '*' || a === '?' || b === '*' || b === '?' || a === b) {
        const ni = a === '*' ? i : i + 1;
        const nj = b === '*' ? j : j + 1;
        if (ni !== i || nj !== j) pila.push([ni, nj]);
      }
    }
  }
  return false;
}

/** Segmentos de un glob; un `**` final es «uno o más segmentos» (un archivo nunca termina en `/`). */
function segmentos(glob) {
  const s = normalizar(glob).split('/');
  if (s[s.length - 1] === '**') s.splice(s.length - 1, 1, '*', '**');
  return s;
}

/** ¿Existe una ruta que cumplan los dos globs? Así se sabe si una exclusión fija «cae bajo» un glob de entra. */
function intersectan(a, b) {
  const A = segmentos(a);
  const B = segmentos(b);
  const memo = new Map();
  const ir = (i, j) => {
    const k = `${i},${j}`;
    if (memo.has(k)) return memo.get(k);
    let r;
    if (i === A.length && j === B.length) r = true;
    else if (i < A.length && A[i] === '**') r = ir(i + 1, j) || (j < B.length && ir(i, j + 1));
    else if (j < B.length && B[j] === '**') r = ir(i, j + 1) || (i < A.length && ir(i + 1, j));
    else if (i < A.length && j < B.length) r = segmentosIntersectan(A[i], B[j]) && ir(i + 1, j + 1);
    else r = false;
    memo.set(k, r);
    return r;
  };
  return ir(0, 0);
}

/** Una entrada de «in» que nombra una exclusión fija (la misma ruta o una carpeta de adentro) es un error. */
function nombraFija(entra, fija) {
  const g = normalizar(entra);
  const f = normalizar(fija);
  if (g === f) return true;
  if (!/[*?]/.test(g)) return coincide(f, g);
  if (!f.endsWith('/**') || /[*?]/.test(f.slice(0, -3))) return false;
  return g.slice(0, g.search(/[*?]/)).startsWith(f.slice(0, -2));
}

// ── Configuraciones ──────────────────────────────────────────────────────────────────────────────────────────
/** Un glob que el exportador no puede razonar: absoluto, con un segmento `..`/`.`, o con `**` pegado a un nombre (el
 *  detector lo lee como «cualquier cosa, cruzando carpetas» y la intersección de globs no: dirían cosas distintas). */
function globMalo(g) {
  if (g.startsWith('/')) return 'es absoluto: las rutas son relativas a la raíz de cada fuente';
  const s = g.split('/');
  if (s.some((x) => x === '..' || x === '.')) return 'tiene un segmento «..» o «.»';
  if (s.some((x) => x.includes('**') && x !== '**')) return '`**` va solo en su segmento (`scripts/**/*.json`, no `scripts/**.json`)';
  return null;
}

function validarLista(lista, ruta) {
  const errores = [];
  if (!lista || typeof lista !== 'object' || !lista.packages || typeof lista.packages !== 'object') {
    throw new NoPudo(`la lista blanca ${ruta} no tiene "packages"`);
  }
  for (const [paq, def] of Object.entries(lista.packages)) {
    if (paq.startsWith('__')) continue;
    for (const f of Object.keys(def || {})) if (!f.startsWith('__') && !FUENTES.includes(f)) errores.push(`${paq}: fuente desconocida «${f}»`);
    for (const f of FUENTES) {
      const d = (def || {})[f];
      if (!d) continue;
      if (!Array.isArray(d.in)) errores.push(`${paq}.${f}.in tiene que ser una lista`);
      for (const g of d.in || []) {
        if (typeof g !== 'string' || !g.trim()) errores.push(`${paq}.${f}.in: un glob vacío`);
        else if (globMalo(g)) errores.push(`${paq}.${f}.in ${g}: ${globMalo(g)}`);
      }
      for (const x of d.out || []) {
        if (!x || typeof x.glob !== 'string' || !x.glob.trim()) errores.push(`${paq}.${f}.out: falta "glob"`);
        else if (!x.reason || !String(x.reason).trim()) errores.push(`${paq}.${f}.out ${x.glob}: un afuera sin motivo («reason») no se acepta`);
        else if (globMalo(x.glob)) errores.push(`${paq}.${f}.out ${x.glob}: ${globMalo(x.glob)}`);
      }
    }
  }
  for (const s of lista.suitesOutside || []) {
    if (!s || !FUENTES.includes(s.root) || !s.path) errores.push(`suitesOutside: cada una necesita "root" (${FUENTES.join(' | ')}) y "path" (${JSON.stringify(s)})`);
    else if (!s.reason || !String(s.reason).trim()) errores.push(`suitesOutside ${s.root}:${s.path}: sin motivo («reason»)`);
  }
  for (const c of lista.casesOutside || []) {
    if (!c || !c.path) errores.push(`casesOutside: falta "path" (${JSON.stringify(c)})`);
    else if (!c.reason || !String(c.reason).trim()) errores.push(`casesOutside ${c.path}: sin motivo («reason»)`);
  }
  for (const [archivo, claves] of Object.entries(lista.empty || {})) {
    if (archivo.startsWith('__')) continue;
    if (!Array.isArray(claves) || !claves.length || claves.some((k) => typeof k !== 'string' || !k || k.split('.').some((x) => !x))) errores.push(`empty ${archivo}: tiene que ser una lista de claves (una anidada, con puntos: «a.b»)`);
  }
  if (lista.publicTexts !== undefined && !Array.isArray(lista.publicTexts)) errores.push('publicTexts: tiene que ser una lista');
  for (const e of Array.isArray(lista.publicTexts) ? lista.publicTexts : []) {
    const quien = e && e.file ? `${e.root}:${e.file}` : JSON.stringify(e);
    if (!e || !FUENTES.includes(e.root) || typeof e.file !== 'string' || !e.file) errores.push(`publicTexts: cada una necesita "root" (${FUENTES.join(' | ')}) y "file" (${quien})`);
    else if (typeof e.text !== 'string' || !e.text) errores.push(`publicTexts ${quien}: sin "text" (el texto exacto del repo)`);
    else if (typeof e.public !== 'string') errores.push(`publicTexts ${quien}: sin "public" (su versión pública; "" lo saca)`);
    else if (!Number.isInteger(e.count) || e.count < 1) errores.push(`publicTexts ${quien}: "count" tiene que ser un entero ≥ 1 (cuántas veces aparece)`);
    else if (!e.reason || !String(e.reason).trim()) errores.push(`publicTexts ${quien}: sin motivo («reason»)`);
  }
  // las convenciones del repo del lector, que la marca de las rutas que no viajan respeta
  if (lista.readerConventions !== undefined && !Array.isArray(lista.readerConventions)) errores.push('readerConventions: tiene que ser una lista de { "path", "reason" }');
  for (const c of Array.isArray(lista.readerConventions) ? lista.readerConventions : []) {
    const quien = c && c.path ? c.path : JSON.stringify(c);
    if (!c || typeof c.path !== 'string' || !c.path.trim() || /[*?]/.test(c.path) || c.path.startsWith('/') || c.path.split('/').includes('..')) errores.push(`readerConventions: cada una necesita "path", una ruta desde la raíz sin globs (con «/» al final, la carpeta entera) (${quien})`);
    else if (!c.reason || !String(c.reason).trim()) errores.push(`readerConventions ${quien}: sin motivo («reason»)`);
  }
  const publicos = Object.keys(lista.packages).filter((p) => !p.startsWith('__') && !PAQUETES_PRIVADOS.includes(p));
  for (const s of lista.synthetic || []) {
    if (!s || !s.target || !s.from) errores.push(`synthetic: cada uno necesita "target" y "from" (${JSON.stringify(s)})`);
    else if (!s.reason || !String(s.reason).trim()) errores.push(`synthetic ${s.target}: sin motivo («reason»)`);
    else if (s.packages !== undefined) {
      // en qué exportaciones aplica — paquetes públicos que la lista define
      if (!Array.isArray(s.packages) || !s.packages.length) errores.push(`synthetic ${s.target}: "packages" es una lista de paquetes públicos`);
      else {
        for (const p of s.packages) {
          if (!publicos.includes(p)) errores.push(`synthetic ${s.target}: "packages" nombra «${p}», que no es un paquete público de la lista (${publicos.join(', ')})`);
        }
      }
    }
  }
  // las skills que la copia publica con otro nombre
  const valorRuta = (v) => typeof v === 'string' && v.trim() && !globMalo(v) && !/[*?]/.test(v) && !v.endsWith('/');
  for (const r of lista.skillRenames || []) {
    if (!r || !FUENTES.includes(r.source)) errores.push(`skillRenames: cada una necesita "source" (${FUENTES.join(' | ')}) (${JSON.stringify(r)})`);
    // (`from` igual a `to` no renombra nada: es la regla tal como queda en la lista de la copia, que ya salió renombrada)
    else if (!valorRuta(r.from) || !valorRuta(r.to)) errores.push(`skillRenames ${r.from}: "from" y "to" son carpetas desde la raíz de su fuente`);
    else if (!r.why || !String(r.why).trim()) errores.push(`skillRenames ${r.from}: sin el texto fijo de su «why»`);
    else if (!r.reason || !String(r.reason).trim()) errores.push(`skillRenames ${r.from}: sin motivo («reason»)`);
  }
  // los archivos que la copia lleva y que no salen de ninguna fuente — los arma el exportador
  if (lista.generated !== undefined && !Array.isArray(lista.generated)) errores.push('generated: tiene que ser una lista de { "target", "reason" }');
  const generados = new Set();
  for (const g of Array.isArray(lista.generated) ? lista.generated : []) {
    if (!g || typeof g.target !== 'string' || !g.target.trim()) errores.push(`generated: cada uno necesita "target" (${JSON.stringify(g)})`);
    else if (!valorRuta(g.target)) errores.push(`generated ${g.target}: "target" es una ruta desde la raíz de la copia, sin globs ni segmentos «..»`);
    else if (!g.reason || !String(g.reason).trim()) errores.push(`generated ${g.target}: sin motivo («reason»)`);
    else if (generados.has(g.target)) errores.push(`generated ${g.target}: declarado dos veces`);
    else if (!GENERATED_FILES.includes(g.target)) errores.push(`generated ${g.target}: el exportador no sabe generar ese archivo (los que genera: ${GENERATED_FILES.join(', ')})`);
    else generados.add(g.target);
  }
  if (errores.length) throw new NoPudo(`la lista blanca ${ruta} no es válida:\n  · ${errores.join('\n  · ')}`);
}

/** La tabla de reemplazos: cualquier problema es un 2 ANTES de escribir nada. */
function validarTabla(tabla, ruta, categorias) {
  if (!tabla || !Array.isArray(tabla.pares)) throw new NoPudo(`la tabla de reemplazos ${ruta} no tiene "pares" (una lista)`);
  const errores = [];
  const anonimos = new Map();
  const reales = new Set();
  const registrar = (anonimo, realDe) => {
    const previo = anonimos.get(anonimo);
    if (previo !== undefined && previo !== realDe) errores.push(`«${anonimo}» lo producen dos reales distintos: ${previo} y ${realDe}`);
    else anonimos.set(anonimo, realDe);
  };
  tabla.pares.forEach((par, i) => {
    const id = par && typeof par.real === 'string' && par.real.trim() ? par.real : `pares[${i}]`;
    if (!par || typeof par.real !== 'string' || !par.real.trim()) { errores.push(`pares[${i}]: falta "real"`); return; }
    if (reales.has(par.real)) errores.push(`${id}: el real está dos veces en la tabla`);
    reales.add(par.real);
    if (!categorias.includes(par.categoria)) errores.push(`${id}: la categoría «${par.categoria}» no está en el vocabulario de denylist.json (${categorias.join(', ')})`);
    if (esMarca(par.real)) errores.push(`${id}: es una marca (TYCON y Bizuit no se reemplazan como palabra suelta)`);
    if (!Array.isArray(par.formas) || !par.formas.length) { errores.push(`${id}: no tiene formas`); return; }
    par.formas.forEach((f, j) => {
      if (!f || typeof f.texto !== 'string' || !f.texto) { errores.push(`${id}: formas[${j}] sin "texto"`); return; }
      if (esMarca(f.texto)) errores.push(`${id}: la forma «${f.texto}» es una marca (TYCON y Bizuit no se reemplazan como palabra suelta)`);
      if (typeof f.anonimo !== 'string' || !f.anonimo) { errores.push(`${id}: la forma «${f.texto}» no tiene anónimo`); return; }
      if (!anonimoAceptable(f.texto, f.anonimo)) {
        errores.push(`${id}: el anónimo «${f.anonimo}» se aplica fuera de .md y tiene espacios o caracteres fuera de [A-Za-z0-9._/:@-] que su forma «${f.texto}» no tiene en el mismo orden`);
      }
      registrar(f.anonimo, par.real);
      // lo que la tabla PRODUCE además de lo declarado — el anónimo en mayúsculas y en minúsculas, que es lo que
      // dejan la caja de lo encontrado (sin `mayusculas`) y las variantes de forma (sin esto, dos reales
      // podrían terminar en el mismo texto y la tabla pasaría)
      if (!par.mayusculas || variantesDeForma(par, f).length) {
        registrar(f.anonimo.toUpperCase(), par.real);
        registrar(f.anonimo.toLowerCase(), par.real);
      }
    });
    if (par.anonimoProsa !== undefined) {
      if (typeof par.anonimoProsa !== 'string' || !par.anonimoProsa.trim()) errores.push(`${id}: "anonimoProsa" vacío`);
      else registrar(par.anonimoProsa, par.real);
    }
  });
  for (const x of tabla.afuera || []) {
    if (!x || typeof x.glob !== 'string' || !FUENTES.some((f) => x.glob.startsWith(`${f}/`))) {
      errores.push(`afuera: el glob va con la carpeta de su fuente adelante (${FUENTES.map((f) => `${f}/…`).join(' o ')}): ${JSON.stringify(x)}`);
    } else if (!x.motivo || !String(x.motivo).trim()) errores.push(`afuera ${x.glob}: sin motivo`);
    else if (globMalo(x.glob.slice(x.glob.indexOf('/') + 1))) errores.push(`afuera ${x.glob}: ${globMalo(x.glob.slice(x.glob.indexOf('/') + 1))}`);
  }
  if (errores.length) throw new NoPudo(`la tabla de reemplazos ${ruta} no es válida:\n  · ${errores.join('\n  · ')}`);
  const pares = tabla.pares.map((par) => ({
    real: par.real,
    prosa: par.anonimoProsa,
    // Cada forma es una grafía exacta con su propio anónimo y su caja: va primero.
    formas: par.formas.map((f) => ({ texto: f.texto, anonimo: f.anonimo, re: regexDeForma(f.texto, par.palabra, 'g') })),
    // `mayusculas` significa lo mismo que en denylist.json: sin `mayusculas: true` el real no distingue caja, así que
    // lo que quede con OTRA caja (`ACMECORP` cuando sólo se declaró `AcmeCorp`) toma el anónimo de su forma con la caja
    // de lo encontrado —todo mayúsculas, todo minúsculas o tal cual—. Con `mayusculas: true`, sólo las formas.
    sinCaja: par.mayusculas ? [] : par.formas.map((f) => ({ anonimo: f.anonimo, re: regexDeForma(f.texto, par.palabra, 'gi') })),
    // lo que el detector también ve (otra caja en un identificador, todo en mayúsculas, un nombre de varias
    // partes separado), armado con SUS funciones: lo que queda es exactamente lo que la tabla no alcanzó
    variantes: par.formas.flatMap((f) => variantesDeForma(par, f)),
  }));
  // un par posterior no puede reescribir el anónimo de uno anterior (los pares se aplican en orden)
  const cadenas = [];
  pares.forEach((par, i) => {
    const producidos = new Set(par.formas.flatMap((f) => (par.sinCaja.length || par.variantes.length
      ? [f.anonimo, f.anonimo.toUpperCase(), f.anonimo.toLowerCase()] : [f.anonimo])));
    if (par.prosa) producidos.add(par.prosa);
    for (const s of producidos) {
      for (const otro of pares.slice(i + 1)) {
        if (reemplazar(s, [otro], false).texto !== s) cadenas.push(`«${s}», el anónimo de ${par.real}, lo vuelve a reemplazar el par de ${otro.real}`);
      }
    }
  });
  if (cadenas.length) throw new NoPudo(`la tabla de reemplazos ${ruta} no es válida:\n  · ${cadenas.join('\n  · ')}`);
  return pares;
}

/** Las variantes de una forma que el exportador reemplaza: las mismas que el detector mira para el término. */
function variantesDeForma(par, f) {
  const v = [];
  if (!f || typeof f.texto !== 'string' || typeof f.anonimo !== 'string') return v;
  if (par.palabra && par.mayusculas && /^[A-Za-z0-9]+$/.test(f.texto)) {
    v.push({ anonimo: f.anonimo, re: detector.regexOtraCaja(f.texto), vale: (x) => x !== f.texto });
    if (f.texto !== f.texto.toUpperCase()) v.push({ anonimo: f.anonimo, re: detector.regexMayusculas(f.texto), vale: () => true });
  }
  if (par.categoria === 'cliente' && detector.partesDe(f.texto).length > 1) {
    v.push({ anonimo: f.anonimo, re: detector.regexPartes(f.texto), vale: detector.conSeparador });
  }
  return v;
}

/** `palabra` usa el MISMO borde que el detector; un nombre pegado lo encuentra el control de nombres pegados. */
function regexDeForma(texto, palabra, flags) {
  return new RegExp(palabra ? `(?<![A-Za-z0-9])${esc(texto)}(?![A-Za-z0-9])` : esc(texto), flags);
}

function cargarDenegados(ruta) {
  try {
    detector.cargarConfig(ruta);
  } catch (e) {
    throw new NoPudo(`la lista de denegación no sirve: ${e.message}`);
  }
  const crudo = leerJson(ruta, 'la lista de denegación');
  const terminos = Array.isArray(crudo.terminos) ? crudo.terminos : [];
  const categorias = [...new Set([...CATEGORIAS, ...terminos.map((t) => t.categoria), ...(crudo.patrones || []).map((p) => p.categoria)])]
    .filter(Boolean).sort(porCodigo);
  return { ruta: path.resolve(ruta), terminos, categorias };
}

// ── Los repos fuente y sus commits ─────────────────────────────────────────────────────────────────────────────
// El repo unido: el arnés y agent-skills son UN repo, y la copia pública tiene que salir igual que desde dos repos. Por
// eso las FUENTES siguen siendo dos, pero lógicas: la lista blanca, las exclusiones y cada
// transformación siguen partidas por fuente, y lo que cambia es de dónde se leen. Si el commit pedido del arnés es del
// repo unido, las dos salen de ESE commit, partido por ruta —`agents/`, `skills/`, `packs/`, `.tycon/post-commit-ignore`
// y `.githooks/pre-commit-skills` son agent-skills; todo lo demás, arnes—, y no se lee ningún otro clon (ni
// TYCON_SKILLS_DIR ni el lugar de instalación: en una máquina en transición el clon viejo sigue ahí, en otro commit).
// Si no lo es (un commit de antes de la unión, o los dos repos de juguete de las pruebas), hay dos repos físicos y todo
// es como siempre. Se decide por el ÁRBOL del commit y no por el disco: el mismo sha da la misma copia en cualquier
// máquina. El criterio y las rutas viven en un solo lugar, new-names.js (`unifiedTree`, `splitTree`); se piden acá
// adentro porque new-names.js usa este archivo.
const ONE_SOURCE = 'en el repo unido las dos fuentes salen de un solo repo, del mismo commit';
/** ¿El commit `ref` de ese repo es del repo unido? Un commit que no se encuentra no decide nada: lo dice después quien
 *  lo resuelve, con su mensaje de siempre. */
function isUnifiedCommit(repo, ref) {
  const r = git(repo.dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  if (r.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return false;
  return require('./new-names.js').unifiedTree(listarArbol(repo, sha));
}

function sourceRepo(fuente, dir) {
  if (!fs.existsSync(dir)) throw new NoPudo(`el repo fuente ${fuente} no está en ${dir}`);
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  if (r.status !== 0) throw new NoPudo(`${dir} no es un repo de git (fuente ${fuente}): ${r.stderr.trim()}`);
  const top = r.stdout.trim();
  return { dir, top: real(top) || path.resolve(top) };
}

function ubicarRepos(args = {}) {
  const env = process.env.TYCON_GUIDES_DIR && process.env.TYCON_GUIDES_DIR.trim();
  const arnes = sourceRepo('arnes', env ? path.resolve(env.replace(/^~(?=$|[\\/])/, os.homedir())) : RAIZ_PROPIA);
  // el commit del arnés primero: uno que no está no decide si el repo es unido, y sin esto se buscaría el otro clon y
  // el error diría «agent-skills no está en …», la causa equivocada. Lo resuelve igual prepararFuentes, después: acá sólo se adelanta su mensaje.
  resolverRef('arnes', arnes, args.arnes || 'origin/main');
  // una fuente física: el otro clon ni se busca (puede no existir, y si existe no es de donde sale la copia)
  if (isUnifiedCommit(arnes, args.arnes || 'origin/main')) return { arnes, 'agent-skills': arnes };
  return { arnes, 'agent-skills': sourceRepo('agent-skills', require('../lib/skills-dir.js').resolveSkillsDirs(process.env.TYCON_SKILLS_DIR).repo) };
}

function resolverRef(fuente, repo, ref) {
  const r = git(repo.dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  if (r.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new NoPudo(`no encuentro el commit «${ref}» en ${fuente} (${repo.dir})`);
  const ct = Number(salidaGit(repo.dir, ['log', '-1', '--format=%ct', sha]).trim());
  if (!Number.isInteger(ct)) throw new NoPudo(`no pude leer la fecha del commit ${sha} de ${fuente}`);
  return { ref, sha, ct };
}

function listarArbol(repo, sha) {
  const out = salidaGit(repo.dir, ['ls-tree', '-r', '-z', '--full-tree', sha]);
  const entradas = [];
  for (const reg of out.split('\0')) {
    if (!reg) continue;
    const tab = reg.indexOf('\t');
    const [modo, tipo, obj] = reg.slice(0, tab).split(' ');
    entradas.push({ modo, tipo, obj, ruta: reg.slice(tab + 1) });
  }
  return entradas;
}

/** El contenido de muchos objetos en UNA llamada (`git cat-file --batch`), sin pasar por el árbol de trabajo. Un objeto de
 *  git no cambia nunca (su nombre ES su contenido): lo ya leído se recuerda. El freno de nombres nuevos lee
 *  las mismas guías, manifiestos y catálogo en la foto de antes y en la de después; sin esto serían ~30 procesos por commit. */
const OBJETOS_LEIDOS = new Map();
function leerObjetos(repo, shas) {
  const unicos = [...new Set(shas)];
  const mapa = new Map();
  if (!unicos.length) return mapa;
  const clave = (sha) => `${repo.dir}\0${sha}`;
  const faltan = unicos.filter((sha) => !OBJETOS_LEIDOS.has(clave(sha)));
  if (faltan.length) {
    const out = salidaGit(repo.dir, ['cat-file', '--batch'], { input: `${faltan.join('\n')}\n`, binario: true });
    let i = 0;
    for (const esperado of faltan) {
      const fin = out.indexOf(0x0a, i);
      const cab = out.slice(i, fin).toString('utf8').split(' ');
      if (cab[1] === 'missing' || cab[0] !== esperado) throw new NoPudo(`git cat-file no devolvió el objeto ${esperado} (${cab.join(' ')})`);
      const n = Number(cab[2]);
      OBJETOS_LEIDOS.set(clave(esperado), out.slice(fin + 1, fin + 1 + n));
      i = fin + 1 + n + 1;
    }
  }
  for (const sha of unicos) mapa.set(sha, OBJETOS_LEIDOS.get(clave(sha)));
  return mapa;
}

// ── Clasificación del primer nivel ─────────────────────────────────────────────────────────────────────────────
function reglasDeFuente(ctx, fuente) {
  const reglas = [];
  for (const [paq, def] of Object.entries(ctx.lista.packages)) {
    if (paq.startsWith('__')) continue;
    const d = (def || {})[fuente];
    if (!d) continue;
    // `tipo` es un valor de la salida de --explain: no cambia con las claves de la lista
    for (const g of d.in || []) reglas.push({ tipo: 'entra', glob: g, detalle: paq });
    for (const x of d.out || []) reglas.push({ tipo: 'afuera', glob: x.glob, detalle: `${x.reason}${x.until ? ` (hasta la ${x.until})` : ''}` });
  }
  for (const x of EXCLUIDOS_SIEMPRE) if (x.fuente === fuente) reglas.push({ tipo: 'fija', glob: x.glob, detalle: x.salvo ? `${x.motivo} — salvo ${x.salvo.join(', ')}: ${x.motivoSalvo}` : x.motivo });
  for (const x of ctx.afueraPrivado) if (x.fuente === fuente) reglas.push({ tipo: 'afuera privado', glob: x.glob, detalle: x.motivo });
  return reglas;
}

function primerNivel(ctx, fuente) {
  const nivel = new Map();
  for (const e of ctx.arboles[fuente]) {
    const i = e.ruta.indexOf('/');
    if (i < 0) nivel.set(e.ruta, 'archivo');
    else if (!nivel.has(e.ruta.slice(0, i))) nivel.set(e.ruta.slice(0, i), 'carpeta');
  }
  const reglas = reglasDeFuente(ctx, fuente);
  return [...nivel.keys()].sort(porCodigo).map((nombre) => {
    const tipo = nivel.get(nombre);
    // Un «in» clasifica si toma algo de la entrada (salir en parte es una decisión); un «out» o una fija, sólo
    // si la cubre ENTERA: `**/denylist*.json` no decide qué pasa con una carpeta nueva de la raíz.
    const aplican = reglas.filter((r) => (r.tipo === 'entra' ? intersectan(r.glob, tipo === 'archivo' ? nombre : `${nombre}/**`) : cubre(r.glob, nombre, tipo)));
    return { fuente, nombre, tipo, reglas: aplican };
  });
}

// ¿El glob cubre la entrada entera? Una carpeta, si cubre cualquier archivo suyo a uno y a dos niveles. La sonda es un
// nombre de TRES caracteres que ningún glob nombra: con uno solo, un afuera `**` + `/?` «cubría» una carpeta sin tomar
// ninguno de sus archivos.
const SONDA = '␀␁␂';
function cubre(glob, nombre, tipo) {
  if (tipo === 'archivo') return coincide(glob, nombre);
  return coincide(glob, `${nombre}/${SONDA}`) && coincide(glob, `${nombre}/${SONDA}/${SONDA}`);
}

// ── Paquetes de revisores: se leen de packs/*/pack.json DEL SHA, no se escriben a mano ───────────────────────────
// El SHA puede ser de antes del renombre (claves del manifiesto en castellano): se lee con `readKeysDeep`, con el
// mismo where que el cargador del pipeline. Una vieja y su nueva con valores distintos es «no pude armar», nunca un
// paquete sin revisores.
const PACK_KEYS_WHERE = 'packs/pack.json';
function revisoresDePaquete(ctx) {
  const ents = ctx.arboles['agent-skills'].filter((e) => e.tipo === 'blob' && /^packs\/[^/]+\/pack\.json$/.test(e.ruta));
  const blobs = leerObjetos(ctx.repos['agent-skills'], ents.map((e) => e.obj));
  const porPaquete = new Map();
  for (const e of ents.sort((a, b) => porCodigo(a.ruta, b.ruta))) {
    let def;
    try {
      def = JSON.parse(blobs.get(e.obj).toString('utf8'));
    } catch (err) {
      throw new NoPudo(`el paquete agent-skills/${e.ruta} no es JSON válido (${err.message})`);
    }
    try {
      // del árbol de un sha: es historia, no un uso del nombre viejo (no se anota)
      def = require('../lib/legacy-names.js').readKeysDeep(def, PACK_KEYS_WHERE, { record: false });
    } catch (err) {
      throw new NoPudo(`el paquete agent-skills/${e.ruta}: ${err.message}`);
    }
    const agentes = new Set((Array.isArray(def.reviewers) ? def.reviewers : []).map((r) => r && r.agent).filter(Boolean));
    porPaquete.set(e.ruta.split('/')[1], agentes);
  }
  return porPaquete;
}

const superficiesDeArchivo = (a) => [
  ['agent-skills', `agents/${a}.md`],
  ['arnes', `adapters/codex/agents/${a}.toml`],
  ['arnes', `adapters/codex/agents-native/${a}.toml`],
  ['arnes', `scripts/controls-bench/cases/advisors/${a}.json`],
];

// ── JSON que conserva el formato: se ubica cada valor y se edita el texto, nunca se re-serializa ─────────────────
function analizarJson(t) {
  let i = 0;
  const ws = () => { while (i < t.length && ' \t\n\r'.includes(t[i])) i++; };
  const cadena = () => {
    const ini = i;
    i++;
    while (i < t.length && t[i] !== '"') i += t[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(t.slice(ini, i));
  };
  const LITERAL = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const valor = () => {
    ws();
    const ini = i;
    if (t[i] === '{' || t[i] === '[') {
      const objeto = t[i] === '{';
      const cierre = objeto ? '}' : ']';
      i++;
      const hijos = [];
      ws();
      if (t[i] === cierre) { i++; return { tipo: objeto ? 'objeto' : 'arreglo', ini, fin: i, hijos }; }
      for (;;) {
        ws();
        const iniHijo = i;
        let clave;
        if (objeto) {
          clave = cadena();
          ws();
          i++;   // «:» (el JSON ya pasó por JSON.parse: es válido)
        }
        const v = valor();
        hijos.push({ clave, ini: iniHijo, fin: v.fin, valor: v });
        ws();
        if (t[i] === ',') { i++; continue; }
        i++;
        return { tipo: objeto ? 'objeto' : 'arreglo', ini, fin: i, hijos };
      }
    }
    if (t[i] === '"') { cadena(); return { tipo: 'valor', ini, fin: i }; }
    LITERAL.lastIndex = i;
    const m = LITERAL.exec(t);
    i += m[0].length;
    return { tipo: 'valor', ini, fin: i };
  };
  return valor();
}

/** Deja en el contenedor sólo los hijos `quedan` (índices), con los separadores y la sangría del original. */
function dejarHijos(t, cont, quedan) {
  const h = cont.hijos;
  if (quedan.length === h.length) return t;
  let cuerpo;
  if (!quedan.length) cuerpo = t[cont.ini] + t[cont.fin - 1];
  else {
    const partes = quedan.map((k, n) => t.slice(h[k].ini, h[k].fin) + (n < quedan.length - 1 ? t.slice(h[k].fin, h[k + 1].ini) : ''));
    cuerpo = t.slice(cont.ini, h[0].ini) + partes.join('') + t.slice(h[h.length - 1].fin, cont.fin);
  }
  return t.slice(0, cont.ini) + cuerpo + t.slice(cont.fin);
}

const miembro = (nodo, clave) => (nodo && nodo.tipo === 'objeto' ? nodo.hijos.find((x) => x.clave === clave) : undefined);
// «a.b» baja de objeto en objeto; devuelve el miembro del último tramo, o undefined si falta uno
function miembroPorRuta(raiz, ruta) {
  let m;
  let nodo = raiz;
  for (const tramo of ruta.split('.')) {
    m = miembro(nodo, tramo);
    if (!m) return undefined;
    nodo = m.valor;
  }
  return m;
}

/** El catálogo sin las secciones de los revisores dados (los encabezados dentro de un bloque de código no cuentan). */
/** Un cerco de código (CommonMark): abre con 3+ ``` o ~~~ y cierra con el MISMO carácter, al menos igual de largo y
 *  sin nada más en la línea (un ~~~ adentro de un bloque de ``` no lo cierra). Devuelve el cerco abierto después de la línea. */
function cerco(linea, abierto) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(linea);
  if (!m) return abierto;
  if (!abierto) return m[1][0] === '`' && m[2].includes('`') ? null : { ch: m[1][0], largo: m[1].length };
  return m[1][0] === abierto.ch && m[1].length >= abierto.largo && !m[2].trim() ? null : abierto;
}

/** Los encabezados `## … — \`<revisor>\`` de las secciones del catálogo, fuera de los bloques de código. */
function recorrerSecciones(texto, alEncabezado, alLinea) {
  let abierto = null;
  for (const l of texto.split('\n')) {
    const antes = abierto;
    abierto = cerco(l, abierto);
    if (!antes && !abierto && /^## /.test(l)) {
      const m = /— `([^`]+)`\s*$/.exec(l);
      alEncabezado(m ? m[1] : null);
    }
    if (alLinea) alLinea(l);
  }
}

function quitarSecciones(texto, agentes) {
  const quitadas = new Set();
  const out = [];
  let saltando = false;
  recorrerSecciones(texto, (agente) => {
    saltando = !!(agente && agentes.has(agente));
    if (saltando) quitadas.add(agente);
  }, (l) => { if (!saltando) out.push(l); });
  return { texto: out.join('\n'), quitadas };
}

function seccionesDe(texto) {
  const hay = new Set();
  recorrerSecciones(texto, (agente) => { if (agente) hay.add(agente); });
  return hay;
}

/** Una línea `!…` del .gitignore que vuelve a incluir algo bajo una exclusión fija, adentro hace viajar datos del
 *  equipo y afuera sólo dejaría sin ignorar lo que escribe la máquina de quien instaló. */
function bajoFija(patron, fuente) {
  const p = patron.replace(/^\//, '').replace(/^(\*\*\/)+/, '');
  return EXCLUIDOS_SIEMPRE.some((x) => {
    if (x.fuente !== fuente) return false;
    if (enSalvo(x, p)) return false;   // lo que el `salvo` deja salir no es un dato del equipo
    const g = normalizar(x.glob);
    if (g.endsWith('/**')) {
      const base = g.slice(0, -3);
      return p === base || p.startsWith(`${base}/`);
    }
    return coincide(g, p.replace(/\/$/, ''));
  });
}

// ── Reemplazos ─────────────────────────────────────────────────────────────────────────────────────────────────
// Todas las expresiones de un par salen de sus formas (la forma tal cual, en otra caja, en mayúsculas o partida con
// un separador): ninguna encuentra nada si el texto, en minúsculas, no contiene la primera parte de alguna forma. Con
// sólo ASCII en la forma, las minúsculas de JS y la `i` de las expresiones coinciden; con otra letra no se atajea.
// Sin el atajo, los ~190 pares sobre cada archivo pesarían una parte grande de cada exportación del núcleo.
// Lo que el atajo busca de cada par se calcula UNA vez: rehacerlo por cada archivo —mirar si cada forma es ASCII,
// partirla y pasarla a minúsculas— costaría segundos en cada exportación del núcleo. `null` = alguna forma no es
// ASCII y no se atajea. export.test.js (T45) lo compara con el cálculo sin atajo, par por par.
const BUSCADO_POR_PAR = new WeakMap();
function parPuedeEstar(par, minusculas) {
  let buscado = BUSCADO_POR_PAR.get(par);
  if (buscado === undefined) {
    buscado = par.formas.some((f) => !/^[\x20-\x7e]*$/.test(f.texto)) ? null : par.formas.map((f) => detector.partesDe(f.texto)[0].toLowerCase());
    BUSCADO_POR_PAR.set(par, buscado);
  }
  return buscado === null || buscado.some((b) => minusculas.includes(b));
}

function reemplazar(texto, pares, esMd) {
  const cuenta = new Map();
  let t = texto;
  let minusculas = t.toLowerCase();
  for (const par of pares) {
    if (!parPuedeEstar(par, minusculas)) continue;
    let n = 0;
    for (const f of par.formas) {
      const anonimo = esMd && par.prosa && f.texto === par.real ? par.prosa : f.anonimo;
      t = t.replace(f.re, () => { n++; return anonimo; });
    }
    for (const f of par.sinCaja) t = t.replace(f.re, (m) => { n++; return conLaCajaDe(m, f.anonimo); });
    for (const f of par.variantes || []) t = t.replace(f.re, (m) => { if (!f.vale(m)) return m; n++; return conLaCajaDe(m, f.anonimo); });
    if (n) { cuenta.set(par.real, n); minusculas = t.toLowerCase(); }
  }
  return { texto: t, cuenta };
}

/** El anónimo con la caja de lo encontrado: todo mayúsculas, todo minúsculas, o como está declarado. */
function conLaCajaDe(encontrado, anonimo) {
  const letras = /[A-Za-z]/.test(encontrado);
  if (letras && encontrado === encontrado.toUpperCase()) return anonimo.toUpperCase();
  if (letras && encontrado === encontrado.toLowerCase()) return anonimo.toLowerCase();
  return anonimo;
}

// ── Controles de la copia ──────────────────────────────────────────────────────────────────────────────────────
/** El borde de palabra deja pasar `<Término>Project`: el detector y los reemplazos usan el mismo, así que un nombre
 *  pegado pasaría los dos. Prefijo de identificador para todos; cualquier posición para los que no distinguen caja.
 *  Para los que distinguen caja, prefijo es lo que sigue con mayúscula o dígito (`<Término>Project`, `<TÉRMINO>2`): con
 *  una minúscula es otra palabra —`Cam` no es el prefijo de «Camino»—.
 *  `permitidos` son las excepciones ya compiladas de la lista de denegación: un pegado deja de ser
 *  hallazgo sólo si una nombra su archivo y su identificador ENTERO (el nombre funcional del sitio de un servidor, que
 *  lleva pegado el de un repo y tiene que quedar). Una excepción sin `patron` —un archivo entero— acá no cuenta, y el
 *  identificador se compara EN SU CAJA: el detector compila los `patron` sin distinguir mayúsculas, pero acá la
 *  excepción nombra un identificador, y el mismo nombre en otra caja es otro hallazgo.
 *  `rutasDe(archivo)` da las rutas con que se compara el archivo (la de la copia y la de su repo); sin ella, la clave. */
function nombresPegados(textos, terminos, permitidos = [], rutasDe = null) {
  const exactos = (permitidos || []).filter((p) => p && p.archivo && p.patron)
    .map((p) => ({ archivo: p.archivo, patron: new RegExp(p.patron.source, p.patron.flags.replace(/[gi]/g, '')) }));
  const permitido = (archivo, identificador) => {
    if (!exactos.length) return false;
    const rutas = rutasDe ? rutasDe(archivo) : [archivo];
    return exactos.some((p) => rutas.some((r) => p.archivo.test(r)) && p.patron.test(identificador));
  };
  const reglas = terminos.filter((t) => t && t.palabra && t.patron).map((t) => {
    const e = esc(t.patron);
    const flags = t.mayusculas ? 'g' : 'gi';
    const res = [t.mayusculas ? new RegExp(`(?<![A-Za-z0-9])${e}(?=[A-Z0-9])`, flags) : new RegExp(`(?<=[A-Za-z0-9])${e}|${e}(?=[A-Za-z0-9])`, flags)];
    // Un término con tilde, escrito sin ella y pegado (`AlmacenService` de `Almacén`): sólo en el borde de
    // un CamelCase, con la inicial en mayúscula (con caja: Node 20 no tiene `(?-i:…)`). En cualquier posición y sin caja
    // sería cada palabra que lo empieza («almacenamiento»): con la tilde eso no pasa, sin ella sí.
    const sinTilde = t.patron.normalize('NFD').replace(/\p{M}/gu, '');
    if (!t.mayusculas && sinTilde !== t.patron && /^[A-Za-z]+$/.test(sinTilde)) {
      const cap = esc(sinTilde[0].toUpperCase() + sinTilde.slice(1).toLowerCase());
      res.push(new RegExp(`(?<=[a-z0-9])${cap}(?:es|s)?(?![a-z])|(?<![A-Za-z])${cap}(?:es|s)?(?=[A-Z][a-z0-9])`, 'g'));
    }
    return { termino: t.patron, res };
  });
  const hallazgos = [];
  for (const [archivo, texto] of textos) {
    texto.split(/\r?\n/).forEach((linea, i) => {
      for (const r of reglas) for (const re of r.res) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(linea)) !== null) {
          let a = m.index;
          let b = m.index + m[0].length;
          while (a > 0 && /[A-Za-z0-9_]/.test(linea[a - 1])) a--;
          while (b < linea.length && /[A-Za-z0-9_]/.test(linea[b])) b++;
          const identificador = linea.slice(a, b);
          if (permitido(archivo, identificador)) continue;
          hallazgos.push({ archivo, linea: i + 1, termino: r.termino, identificador });
        }
      }
    });
  }
  return hallazgos;
}

// El primer renglón de un archivo sin extensión dice si es un guion de shell (`#!/bin/bash`, `#!/usr/bin/env bash`, `sh`).
function shebangDeShell(abs) {
  let primera = '';
  try { primera = fs.readFileSync(abs, 'utf8').split('\n', 1)[0]; } catch (e) { throw new NoPudo(`no pude leer ${abs} (${e.code || e.message}) para ver si es un guion`); }
  return /^#!\s*\S*(?:\/|\s)(?:bash|sh)(?:\s|$)/.test(primera);
}

// ¿Este .js o .cjs compila como CommonJS? Se mira en este mismo proceso, con la envoltura con que node carga un módulo
// CommonJS (por eso vale un `return` suelto y no cuenta el `#!`). Sólo contesta «sí»: ante cualquier otra cosa —no
// compila, no se deja leer, es de un paquete declarado módulo— decide `node --check`, como siempre, y el detalle de la
// falla es el suyo. Un proceso de node por cada uno de los ~400 .js de la copia sería una parte grande del tiempo de cada
// exportación del núcleo (export.test.js T44 compara el informe con el de un proceso por archivo).
const PARAMETROS_COMMONJS = ['exports', 'require', 'module', '__filename', '__dirname'];
function compilaComoCommonJs(abs, dirCopia, tipoDe) {
  if (!/\.c?js$/.test(abs)) return false;
  if (!abs.endsWith('.cjs') && paqueteModulo(path.dirname(abs), dirCopia, tipoDe)) return false;
  try {
    let fuente = fs.readFileSync(abs, 'utf8');
    const conMarca = fuente.charCodeAt(0) === 0xfeff;
    if (conMarca) fuente = fuente.slice(1);
    // node acepta el `#!` sólo en el primer carácter: detrás de una marca de orden de bytes (un editor de Windows la
    // agrega) el archivo no carga. Acá no se decide: va a `node --check`.
    if (conMarca && fuente.startsWith('#!')) return false;
    vm.compileFunction(fuente.replace(/^#!.*/, ''), PARAMETROS_COMMONJS, { filename: abs });
    return true;
  } catch (_) {
    return false;
  }
}
// El `package.json` más cercano, sin salir de la copia, ¿declara `"type": "module"`? Uno que no se deja leer cuenta
// como que sí: decide `node --check`.
function paqueteModulo(dir, dirCopia, tipoDe) {
  if (tipoDe.has(dir)) return tipoDe.get(dir);
  let es = false;
  const pkg = path.join(dir, 'package.json');
  if (fs.existsSync(pkg)) {
    try { es = JSON.parse(fs.readFileSync(pkg, 'utf8')).type === 'module'; } catch (_) { es = true; }
  } else if (dir !== dirCopia && dentroDe(dir, dirCopia)) es = paqueteModulo(path.dirname(dir), dirCopia, tipoDe);
  tipoDe.set(dir, es);
  return es;
}

/** `opciones` es de las pruebas: `inProcess: false` vuelve al proceso por archivo, y `spawned` junta lo que se lanzó. */
function compilan(dirCopia, rutas, aux, opciones = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const fallas = [];
  const tipoDe = new Map();
  for (const r of rutas) {
    const abs = path.join(dirCopia, r);
    let cmd;
    if (opciones.inProcess !== false && compilaComoCommonJs(abs, dirCopia, tipoDe)) continue;
    if (/\.[cm]?js$/.test(r)) cmd = [process.execPath, ['--check', abs], 'node --check'];
    else if (r.endsWith('.sh')) cmd = ['bash', ['-O', 'extglob', '-n', abs], 'bash -n'];   // extglob: un script que lo prende es legítimo
    else if (r.endsWith('.py')) cmd = ['python3', ['-m', 'py_compile', abs], 'python3 -m py_compile'];
    // un guion de shell sin extensión (los .githooks, tycon-prod-sql) también, por su shebang —
    // la transformación public-texts puede sacar un bloque de un pre-commit y tiene que seguir compilando
    else if (!path.basename(r).includes('.') && shebangDeShell(abs)) cmd = ['bash', ['-O', 'extglob', '-n', abs], 'bash -n'];
    else continue;
    if (opciones.spawned) opciones.spawned.push(abs);
    const res = spawnSync(cmd[0], cmd[1], { encoding: 'utf8', env: { ...env, PYTHONPYCACHEPREFIX: path.join(aux, 'pycache') } });
    if (res.error) throw new NoPudo(`no pude correr ${cmd[2]} sobre ${r} (${res.error.code || res.error.message}): sin eso no puedo decir que la copia compila`);
    if (res.status !== 0) {
      const lineas = `${res.stderr || ''}${res.stdout || ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
      // La carpeta temporal lleva el PID: el detalle va con la ruta de la copia, o dos corridas iguales darían distinto.
      const detalle = (lineas.find((l) => /Error/.test(l)) || lineas[0] || `salió ${res.status}`).split(`${dirCopia}${path.sep}`).join('').split(dirCopia).join('<copia>');
      fallas.push({ archivo: r, herramienta: cmd[2], detalle });
    }
  }
  return fallas;
}

// Un comando que manda correr un script del arnés o de agent-skills, dicho como lo dicen las guías y las skills. El arnés
// se nombra por cualquiera de los dos nombres de su lugar (el lugar y el viejo, de setup/harness/place.js).
// Se arma la primera vez que se usa: quien carga este archivo sólo para un lector (el freno de nombres en un laboratorio
// con algunos guiones copiados) no necesita place.js.
let commandPrefixesCache = null;
function PREFIJOS_COMANDO() {
  if (commandPrefixesCache) return commandPrefixesCache;
  const P = require('../setup/harness/place.js');
  const names = [P.PLACE_NAME, P.LEGACY_PLACE_NAME].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  commandPrefixesCache = [
    [new RegExp(`^(?:~|\\$HOME|\\$\\{HOME\\})\\/\\.claude\\/(?:${names})\\/`), 'arnes/'],
    [/^\$\{TYCON_GUIDES_DIR(?::-[^}]*)?\}\//, 'arnes/'],
    [/^\$TYCON_GUIDES_DIR\//, 'arnes/'],
    [/^(?:~|\$HOME|\$\{HOME\})\/\.claude\/agent-skills\//, 'agent-skills/'],
    [/^(?:~|\$HOME|\$\{HOME\})\/\.claude\/skills\//, 'agent-skills/skills/'],
  ];
  return commandPrefixesCache;
}
// Con opciones entre el ejecutable y la ruta (`node --test x.js`, `bash -x x.sh`): sin esto se escaparían.
const COMANDO = /\b(?:node|bash)\s+(?:-{1,2}[A-Za-z][\w-]*(?:=\S+)?\s+)*(["']?)([^\s"'`;|&()]+\.(?:js|sh))\1/g;

function candidatosDeComando(dicha, md) {
  // Los marcadores que las skills y los comandos usan con un solo sentido: `<skill>` es la skill del .md, `<arnés>` el
  // arnés, y `<repo>` en un comando del arnés es el arnés. Cualquier otro marcador no se puede resolver.
  const skillDelMd = /^agent-skills\/skills\/([^/]+)\//.exec(md);
  const placeRoot = `~/.claude/${require('../setup/harness/place.js').PLACE_NAME}/`;   // `<arnés>/` y `<repo>/` van al lugar (8.19)
  let ruta = dicha.replace(/^<(?:arnés|arnes)>\//, placeRoot);
  if (skillDelMd) ruta = ruta.replace(/^<skill>\//, `~/.claude/agent-skills/skills/${skillDelMd[1]}/`);
  if (md.startsWith('arnes/')) ruta = ruta.replace(/^<repo>\//, placeRoot);
  for (const [re, pre] of PREFIJOS_COMANDO()) if (re.test(ruta)) return [path.posix.normalize(pre + ruta.replace(re, ''))];
  // Una variable, un marcador (`<skill>`, `...`) o una ruta de la máquina: no se puede resolver, no se juzga.
  if (/[$~<>{}*]|\.\.\.|…/.test(ruta) || ruta.startsWith('/')) return null;
  // Relativa: al .md, a la raíz de cualquiera de las dos fuentes (las skills citan scripts del arnés así) y, en una
  // skill, a su carpeta y a su scripts/ (sus pasos dicen `node lib/x.js` desde ahí).
  const c = [path.posix.join(path.posix.dirname(md), ruta), ...FUENTES.map((f) => `${f}/${ruta}`)];
  if (skillDelMd) c.push(`agent-skills/skills/${skillDelMd[1]}/${ruta}`, `agent-skills/skills/${skillDelMd[1]}/scripts/${ruta}`);
  return c.map((x) => path.posix.normalize(x));
}

function comandosColgados(textos, existe) {
  const hallazgos = [];
  for (const [md, texto] of textos) {
    if (!md.endsWith('.md') || !(md.startsWith('arnes/commands/') || md.startsWith('agent-skills/skills/'))) continue;
    texto.split(/\r?\n/).forEach((linea, i) => {
      COMANDO.lastIndex = 0;
      let m;
      while ((m = COMANDO.exec(linea)) !== null) {
        const cands = candidatosDeComando(m[2], md);
        if (cands && !cands.some((c) => existe.has(c))) hallazgos.push({ archivo: md, linea: i + 1, ruta: m[2] });
      }
    });
  }
  return hallazgos;
}

// ── La corrida ─────────────────────────────────────────────────────────────────────────────────────────────────
const TEMPORALES = [];   // lo que creó ESTA corrida: lo único que se borra al salir
function limpiar() {
  for (const d of TEMPORALES.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (e) {
      // Un temporal que no se pudo borrar puede tener justo lo que el detector rechazó: se dice, no se traga.
      process.stderr.write(`⚠️ exportador: no pude borrar el temporal ${d} (${(e && e.code) || e}) — borralo a mano\n`);
    }
  }
}

function parsear(argv) {
  // la opción (en inglés) → la clave de adentro, que no cambia
  const conValor = new Map([['--package', 'paquete'], ['--output', 'salida'], ['--harness', 'arnes'], ['--agent-skills', 'agent-skills'],
    ['--report', 'informe'], ['--allowlist', 'lista-blanca'], ['--replacements', 'reemplazos'], ['--denied', 'denegados'],
    ['--public-repos', 'publicRepos'], ['--stamp-version', 'stampVersion']]);
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') a.json = true;
    else if (x === '--explain') a.explicar = true;
    else if (x === '--single-repo') a.singleRepo = true;
    else if (conValor.has(x)) {
      const v = argv[++i];
      if (v === undefined || v === '' || v.startsWith('--')) throw new NoPudo(`${x} necesita un valor (vacío no es un valor: no cae al default)`);
      a[conValor.get(x)] = v;   // la última vez que aparece manda
    } else throw new NoPudo(`opción desconocida: ${x}`);
  }
  return a;
}

function rutasDeConfig(args) {
  const base = path.join(RAIZ_PROPIA, 'scripts', 'publishing');
  return {
    lista: path.resolve(args['lista-blanca'] || path.join(base, 'allowlist.json')),
    reemplazos: path.resolve(args.reemplazos || path.join(base, 'replacements.json')),
    denegados: path.resolve(args.denegados || path.join(base, 'denylist.json')),
    publicRepos: path.resolve(args.publicRepos || path.join(RAIZ_PROPIA, PUBLIC_REPOS)),
  };
}

/**
 * El nombre público del repo: `{ org, repo }` de `public-repos.json` (o del archivo dado). Es el único
 * lector de esas claves —lo reusa la sincronización—. Tira (NoPudo: el exportador sale 2) si el archivo falta o
 * no se lee, si le falta una de las dos claves o si una trae caracteres fuera de [A-Za-z0-9._-].
 */
function readPublicRepo(file = path.join(RAIZ_PROPIA, PUBLIC_REPOS)) {
  return validarNombrePublico(leerJson(file, 'el nombre público'), file);
}
/** Las dos claves del nombre público, validadas (lo comparten el lector del disco y la clasificación de un commit). */
function validarNombrePublico(datos, file) {
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) throw new NoPudo(`el nombre público ${file} no es un objeto con "org" y "repo"`);
  const out = {};
  for (const k of ['org', 'repo']) {
    const v = datos[k];
    if (typeof v !== 'string' || !v) throw new NoPudo(`el nombre público ${file}: falta "${k}"`);
    if (!PUBLIC_NAME_OK.test(v)) throw new NoPudo(`el nombre público ${file}: "${k}" = «${v}» tiene caracteres fuera de [A-Za-z0-9._-]`);
    out[k] = v;
  }
  return out;
}

/**
 * Los archivos que pueden escribir la dirección del repo público: `[{ path, why }]` de `public-name-exceptions.json` (o del
 * archivo dado). Una ruta que termina en «/» vale para toda la carpeta. Tira (NoPudo) si el archivo falta o no se lee, si
 * una entrada no trae ruta o motivo, o si una ruta se repite: exceptuar sin motivo es esconder.
 */
function readPublicNameExceptions(file = path.join(RAIZ_PROPIA, PUBLIC_NAME_EXCEPTIONS)) {
  const datos = leerJson(file, 'las excepciones del nombre público');
  const lista = datos && Array.isArray(datos.files) ? datos.files : null;
  if (!lista) throw new NoPudo(`las excepciones del nombre público ${file} no traen "files" (una lista de { path, why })`);
  const vistas = new Set();
  return lista.map((e, i) => {
    const p = e && typeof e.path === 'string' ? e.path.trim() : '';
    const why = e && typeof e.why === 'string' ? e.why.trim() : '';
    if (!p) throw new NoPudo(`las excepciones del nombre público ${file}: la entrada ${i} no trae "path"`);
    if (!why) throw new NoPudo(`las excepciones del nombre público ${file}: ${p} no trae "why" (exceptuar sin motivo es esconder)`);
    if (vistas.has(p)) throw new NoPudo(`las excepciones del nombre público ${file}: ${p} está dos veces`);
    vistas.add(p);
    return { path: p, why };
  });
}

/** Los paquetes de una exportación: una lista, o el nombre de uno, o varios separados por coma. */
const packageList = (P) => (Array.isArray(P) ? P : String(P).split(','));

/** Lo que comparten --explain y la exportación: configuraciones, repos, commits y árboles. */
function prepararFuentes(ctx, args, cfg) {
  ctx.lista = paquetesConNombresNuevos(leerJson(cfg.lista, 'la lista blanca'));   // la del disco: con las claves actuales
  validarLista(ctx.lista, cfg.lista);
  ctx.denegados = cargarDenegados(cfg.denegados);
  ctx.tablaCruda = leerJson(cfg.reemplazos, 'la tabla de reemplazos');
  ctx.pares = validarTabla(ctx.tablaCruda, cfg.reemplazos, ctx.denegados.categorias);
  ctx.afueraPrivado = (ctx.tablaCruda.afuera || []).map((x) => {
    const barra = x.glob.indexOf('/');
    return { fuente: x.glob.slice(0, barra), glob: x.glob.slice(barra + 1), motivo: x.motivo };
  });
  ctx.fuentes = {};
  ctx.arboles = {};
  // una fuente física (el repo unido) o dos — lo decide el árbol del commit del arnés
  ctx.unified = isUnifiedCommit(ctx.repos.arnes, args.arnes || 'origin/main');
  if (ctx.unified) {
    const repo = ctx.repos.arnes;
    ctx.repos = { arnes: repo, 'agent-skills': repo };
    const one = resolverRef('arnes', repo, args.arnes || 'origin/main');
    let skillsRef = one.ref;
    if (args['agent-skills'] !== undefined) {
      const other = resolverRef('agent-skills', repo, args['agent-skills']);
      if (other.sha !== one.sha) {
        throw new NoPudo(`--agent-skills «${other.ref}» (${corto(other.sha)}) no es el mismo commit que --harness «${one.ref}» (${corto(one.sha)}): ${ONE_SOURCE} — sacá --agent-skills, o pasale el mismo commit`);
      }
      skillsRef = other.ref;
    }
    ctx.fuentes = { arnes: one, 'agent-skills': { ref: skillsRef, sha: one.sha, ct: one.ct } };
    ctx.arboles = require('./new-names.js').splitTree(listarArbol(repo, one.sha));
    return;
  }
  for (const f of FUENTES) {
    ctx.fuentes[f] = resolverRef(f, ctx.repos[f], args[f === 'arnes' ? 'arnes' : 'agent-skills'] || 'origin/main');
    ctx.arboles[f] = listarArbol(ctx.repos[f], ctx.fuentes[f].sha);
  }
}

// Los nombres a tachar son los términos `cliente` de la lista de denegación, una sola lista. Un cliente sin par lo
// mira `termsWithoutPair` sobre esa lista, y un producto dado de alta sin término, `unseenProducts`.

// ── La lista al día ─────────────────────────────────────────────────────────────────────────────────
// (PARIDAD, arriba con las exclusiones fijas)

/** Los productos del registro de paridad que la lista de denegación no ve: cada alta trae su término. Un sha de
 *  antes de la mudanza lo tiene en su ruta vieja (del mapa). */
function unseenProducts(ctx) {
  const e = [PARIDAD, ...rutasViejasDe(PARIDAD)].map((r) => ctx.arboles.arnes.find((x) => x.ruta === r && x.tipo === 'blob')).find(Boolean);
  if (!e) return [];
  let registro;
  try {
    registro = JSON.parse(leerObjetos(ctx.repos.arnes, [e.obj]).get(e.obj).toString('utf8'));
  } catch (err) {
    throw new NoPudo(`${PARIDAD} no es JSON válido (${err.message}): sin él no sé qué productos tiene que ver la lista`);
  }
  return unseenValues([...productsOf(registro)], detector.cargarConfig(ctx.denegados.ruta));
}

/** Los valores `producto` de los grupos del registro de paridad (lo usa también el freno de nombres nuevos). */
function productsOf(registro) {
  const valores = new Set();
  const recorrerGrupos = (o) => {
    if (Array.isArray(o)) o.forEach(recorrerGrupos);
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'producto' && typeof v === 'string') valores.add(v); else recorrerGrupos(v); }
  };
  recorrerGrupos(registro && registro.grupos);
  return valores;
}

/** De unos valores, los que la lista (una config ya cargada del detector) no ve como nombre. */
function unseenValues(valores, cfg) {
  return [...valores].sort(porCodigo).filter((v) => !detector.reviewText(cfg, v, PARIDAD).hallazgos.some((h) => CATEGORIAS.includes(h.categoria)));
}

/** ¿El término tiene par? Que la tabla lo tape: el reemplazo de verdad (`pares` compilados por validarTabla)
 *  cambia su grafía. Así manda la caja del PAR, que es quien reemplaza: uno sin `mayusculas` tapa cualquier caja, uno con
 *  `mayusculas` sólo sus formas (comparar con la caja del término daría los dos errores). */
function termHasPair(term, pares) {
  if (!term || typeof term.patron !== 'string') return false;
  return reemplazar(term.patron, pares || [], false).texto !== term.patron;
}

/** Los términos de la lista sin par (`pares` compilados): `[{ indice, categoria }]` — nunca el valor (la salida estándar no
 *  es privada). */
function termsWithoutPair(terminos, pares) {
  return (terminos || []).map((t, indice) => ({ t, indice })).filter(({ t }) => !termHasPair(t, pares))
    .map(({ t, indice }) => ({ indice, categoria: (t && t.categoria) || '(sin categoría)' }));
}

/**
 * Cuántos archivos cubre cada exclusión (fija, «out» de la lista, «afuera» privado) en el sha, sin contar los
 * reemplazos que deja una mudanza: un reemplazo `.md` en la ruta vieja satisface el glob viejo mientras
 * la guía de verdad sale por su ruta nueva. `relevante` = cae bajo un glob de «in» (si no, sin archivo no deja salir
 * nada). Un «afuera» privado no muestra su glob (es privado): va por su posición. Lee el contenido sólo de lo que puede ser
 * un reemplazo (su extensión tiene forma de reemplazo), en un solo pedido a git por fuente.
 */
function coberturaExclusiones(ctx) {
  const legacy = require('../lib/legacy-names.js');
  const hitsDe = new Map();
  const hits = (f, glob) => {
    const k = `${f}\0${glob}`;
    if (!hitsDe.has(k)) hitsDe.set(k, ctx.arboles[f].filter((e) => e.tipo === 'blob' && coincide(glob, e.ruta)));
    return hitsDe.get(k);
  };
  const esReemplazo = new Map();
  const cubre = (f, glob) => {
    const h = hits(f, glob);
    const leer = h.filter((e) => legacy.supportsShim(e.ruta) && !esReemplazo.has(`${f}\0${e.obj}`));
    if (leer.length) {
      const datos = leerObjetos(ctx.repos[f], leer.map((e) => e.obj));
      for (const e of leer) esReemplazo.set(`${f}\0${e.obj}`, legacy.isShim(datos.get(e.obj).toString('utf8')));
    }
    const reemplazos = h.filter((e) => esReemplazo.get(`${f}\0${e.obj}`) === true).length;
    return { archivos: h.length - reemplazos, reemplazos };
  };
  const paquetes = Object.keys(ctx.lista.packages).filter((p) => !p.startsWith('__'));
  const entra = (P, f) => ((ctx.lista.packages[P] || {})[f] || { in: [] }).in;
  const filas = [];
  for (const f of FUENTES) {
    for (const x of EXCLUIDOS_SIEMPRE.filter((y) => y.fuente === f && !y.clase)) {
      filas.push({ origen: 'fija', fuente: f, glob: x.glob, relevante: paquetes.some((P) => entra(P, f).some((g) => intersectan(g, x.glob))), ...cubre(f, x.glob) });
    }
    for (const P of paquetes) {
      for (const a of (ctx.lista.packages[P][f] || {}).out || []) {
        filas.push({ origen: 'afuera', paquete: P, fuente: f, glob: a.glob, relevante: entra(P, f).some((g) => intersectan(g, a.glob)), ...cubre(f, a.glob) });
      }
    }
    ctx.afueraPrivado.forEach((a, i) => {
      if (a.fuente !== f) return;
      filas.push({ origen: 'afuera-privado', indice: i, fuente: f, relevante: paquetes.some((P) => entra(P, f).some((g) => intersectan(g, a.glob))), ...cubre(f, a.glob) });
    });
  }
  return filas;
}

function explicar(args, cfg) {
  const ctx = { repos: ubicarRepos(args) };
  prepararFuentes(ctx, args, cfg);
  const filas = FUENTES.flatMap((f) => primerNivel(ctx, f));
  const cobertura = coberturaExclusiones(ctx);
  const sinArchivo = cobertura.filter((x) => x.relevante && x.archivos === 0);
  // sin el mapa de renombres (la copia pública, o un sha de antes del renombre) no hay rutas viejas
  const hayMapa = ctx.arboles.arnes.some((e) => e.ruta === MAPA_RENOMBRES && e.tipo === 'blob');
  const legacyMap = { path: MAPA_RENOMBRES, present: hayMapa, note: hayMapa ? 'las rutas viejas que un repo nombra del otro se reescriben con el mapa' : NO_MAP_NOTE };
  // lo que la copia lleva sin que salga de ninguna fuente
  const generados = (ctx.lista.generated || []).map((g) => ({ target: g.target, reason: g.reason }));
  // los sintéticos —lo que la copia lleva desde un papel, como los guiones de entrada—, con su origen
  const synthetics = (ctx.lista.synthetic || []).map((x) => ({ target: x.target, from: x.from, packages: x.packages || null, reason: x.reason }));
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      fuentes: Object.fromEntries(FUENTES.map((f) => [f, { ref: ctx.fuentes[f].ref, sha: ctx.fuentes[f].sha }])),
      physicalSources: ctx.unified ? 1 : 2,
      primerNivel: filas.map((r) => ({ fuente: r.fuente, entrada: r.nombre, tipo: r.tipo, reglas: r.reglas })),
      sinClasificar: filas.filter((r) => !r.reglas.length).map((r) => `${r.fuente}/${r.nombre}`),
      exclusionesFijas: EXCLUIDOS_SIEMPRE,
      coberturaExclusiones: cobertura,
      exclusionesSinArchivo: sinArchivo,
      transformaciones: TRANSFORMACIONES,
      controls: COPY_CONTROLS,
      legacyMap,
      generated: generados,
      synthetic: synthetics,
    }, null, 2)}\n`);
    return 0;
  }
  const l = [`Primer nivel de cada fuente (arnes @ ${corto(ctx.fuentes.arnes.sha)}, agent-skills @ ${corto(ctx.fuentes['agent-skills'].sha)})${ctx.unified ? ' — el repo unido: las dos salen del mismo commit, partido por ruta' : ''}`];
  for (const f of FUENTES) {
    l.push('', f);
    for (const r of filas.filter((x) => x.fuente === f)) {
      const nombre = `${r.nombre}${r.tipo === 'carpeta' ? '/' : ''}`.padEnd(34);
      if (!r.reglas.length) { l.push(`  ${nombre} 🛑 SIN CLASIFICAR (la exportación sale 2)`); continue; }
      const vistos = new Set();
      r.reglas.forEach((x, i) => {
        const txt = `${x.tipo}: ${x.tipo === 'entra' ? `${x.detalle} (${x.glob})` : `${x.glob} — ${x.detalle}`}`;
        if (vistos.has(txt)) return;
        vistos.add(txt);
        l.push(`  ${i === 0 ? nombre : ' '.repeat(34)} ${txt}`);
      });
    }
  }
  l.push('', 'Exclusiones fijas (nunca salen, cubra lo que cubra «in»)');
  for (const x of EXCLUIDOS_SIEMPRE) {
    l.push(`  ${x.fuente.padEnd(13)} ${x.glob.padEnd(46)} ${x.motivo}${x.clase ? ' (clase: no se le exige archivo)' : ''}`);
    if (x.salvo) l.push(`  ${' '.repeat(13)} ${'  salvo'.padEnd(46)} ${x.salvo.join(', ')}: ${x.motivoSalvo}`);
  }
  if (sinArchivo.length) {
    l.push('', '🛑 Exclusiones que ya no cubren ningún archivo (la exportación sale 2 — ¿se movió el archivo sin su glob?)');
    for (const x of sinArchivo) {
      const cual = x.origen === 'afuera-privado' ? `afuera privado #${x.indice}` : `${x.origen}${x.paquete ? ` (${x.paquete})` : ''} ${x.glob}`;
      l.push(`  ${x.fuente.padEnd(13)} ${cual}${x.reemplazos ? ' — sólo queda su reemplazo en la ruta vieja' : ''}`);
    }
  }
  l.push('', 'Transformaciones con nombre');
  for (const t of TRANSFORMACIONES) l.push(`  ${t.nombre.padEnd(22)} ${t.que}`);
  l.push('', 'Archivos generados (allowlist.json → generated: no salen de ninguna fuente)');
  if (!generados.length) l.push('  (ninguno)');
  for (const g of generados) l.push(`  ${g.target.padEnd(22)} ${g.reason}`);
  l.push('', 'Sintéticos (allowlist.json → synthetic: el archivo de la copia sale de un papel, no de su ruta en la fuente)');
  if (!synthetics.length) l.push('  (ninguno)');
  for (const x of synthetics) l.push(`  ${x.target.padEnd(34)} ← ${x.from}${x.packages ? ` (${x.packages.join(', ')})` : ''}`);
  l.push('', 'Controles de la copia (un hallazgo es exit 1; pathsNotInCopy, links, readmePaths, attributions, skillRenameLeft y handWrittenPublicUrl, sólo si la exportación incluye core)');
  for (const c of COPY_CONTROLS) l.push(`  ${c.nombre.padEnd(22)} ${c.que}`);
  l.push('', `Mapa de renombres (${MAPA_RENOMBRES}): ${hayMapa ? 'presente — las rutas viejas que un repo nombra del otro se reescriben con él' : NO_MAP_NOTE}`);
  process.stdout.write(`${l.join('\n')}\n`);
  return 0;
}

// ── --single-repo: las dos fuentes juntas desde la raíz de UN repo ──────────────────────────────────────────────────
// Una ruta que llega de las dos fuentes sale 2, salvo el .gitignore, que tiene transformación con nombre (unido).
const PRE_COMMIT = '.githooks/pre-commit';

// El repo unido, en la copia de DOS repos. Sin --single-repo cada fuente sale como un repo propio. El repo
// unido trae el pre-commit ya partido —las dos partes y el despachador que las corre en UN repo—: en dos repos el
// despachador llamaría a una parte que quedó en el otro, y en el repo «arnes» de la copia ningún commit se podría crear
// (export-real.test.sh, T21, lo verifica: «pre-commit-skills: No such file or directory»). Cada parte vuelve a ser el
// `.githooks/pre-commit` del repo de su fuente y el despachador no sale: la forma
// que la copia de dos repos tuvo siempre. Va sobre las claves de la copia, antes de escribirla en disco.
// Con UNA sola parte sale 2 nombrando la que falta: la copia saldría con un pre-commit que llama a un archivo que no
// está. Sin ninguna de las dos (el control único `.githooks/pre-commit-checks`, que es del arnés, o una lista blanca que
// deja `.githooks/` afuera) no hay nada que partir. Casos: export.test.js, *SplitHooks*.
const HOOK_PARTS = Object.freeze({ arnes: `${PRE_COMMIT}-harness`, 'agent-skills': `${PRE_COMMIT}-skills` });
function splitHooks(copia, ajustes) {
  const missing = FUENTES.filter((f) => !copia.has(`${f}/${HOOK_PARTS[f]}`)).map((f) => HOOK_PARTS[f]);
  if (missing.length === FUENTES.length) {   // sin las dos partes (el control único, o ningún pre-commit): nada que partir
    // …pero el control único es un envoltorio que ejecuta .githooks/pre-commit-checks: sin él, la copia saldría con un
    // pre-commit que llama a un archivo que no está (sin esto, saldría callado)
    const hook = copia.get(`arnes/${PRE_COMMIT}`);
    if (hook && hook.datos && hook.datos.toString('utf8').includes('pre-commit-checks') && !copia.has(`arnes/${PRE_COMMIT}-checks`)) {
      throw new NoPudo(`split-hooks: sale arnes/${PRE_COMMIT} pero no arnes/${PRE_COMMIT}-checks, que es lo que ejecuta — la copia tendría un pre-commit que llama a un archivo que no está`);
    }
    return;
  }
  if (missing.length) {
    throw new NoPudo(`split-hooks: falta ${missing.join(' y ')} en la copia — el repo unido trae el pre-commit partido en dos y la copia de dos repos necesita las dos partes (sin ella, el repo de esa fuente saldría con un pre-commit que llama a un archivo que no está)`);
  }
  copia.delete(`arnes/${PRE_COMMIT}`);   // el despachador
  for (const f of FUENTES) {
    const part = `${f}/${HOOK_PARTS[f]}`;
    const own = `${f}/${PRE_COMMIT}`;
    if (copia.has(own)) throw new NoPudo(`split-hooks: ${own} ya sale y ${part} iría al mismo lugar — en el repo unido el .githooks/pre-commit es sólo el despachador`);
    copia.set(own, copia.get(part));
    copia.delete(part);
    ajustes.push({ transformacion: 'split-hooks', archivo: own, detalle: `es ${HOOK_PARTS[f]} del repo unido: la parte del pre-commit de esta fuente (el despachador no sale en la copia de dos repos)` });
  }
}

// ── el .gitignore del repo único ignora las carpetas de las que no sale nada ────────────────────────────────────────
// POR QUÉ: quien mantiene el arnés escribe en un clon del repo que nace de esta copia, y sus herramientas dejan ahí la
// memoria, las historias, los planes y la evidencia de las corridas. El .gitignore sale del repo fuente menos las
// líneas «!…» (arriba, en la transformación), así que ignoraría sólo lo que el fuente ya ignora, y un `git add` común
// subiría las carpetas de primer nivel sin nada público que el fuente no ignora.
// QUÉ CARPETAS: las de primer nivel del commit fuente (las dos fuentes lógicas) que no tienen NINGÚN archivo en la forma
// final. Sale de lo que la lista blanca deja salir, nunca de una lista escrita acá: una carpeta privada nueva entra
// sola, y una que empieza a publicar algo deja de entrar. Se mira la forma FINAL, con los papeles ya en su destino:
// una carpeta que la copia sólo recibe por un sintético no se ignora. Las mezcladas (sale una parte) tampoco: ahí un
// archivo nuevo puede ser público.
// SÓLO con --single-repo: es la forma que se publica. Sin .gitignore en la copia (un paquete solo) no se inventa uno.
const PRIVATE_FOLDERS_NOTE = Object.freeze([
  '# Carpetas de trabajo de quien mantiene el arnés (su memoria, sus historias, sus planes y lo que generan sus',
  '# máquinas): no son de este repo. Si aparecen en tu copia de trabajo, no se commitean.',
]);
/** La línea del .gitignore que ignora esa carpeta de la raíz: anclada, y con lo que git leería como patrón, escapado. */
const rootFolderLine = (folder) => `/${folder.replace(/[\\*?[\]]/g, '\\$&').replace(/ $/, '\\ ')}/`;

function ignorePrivateFolders(ctx, forma, ajustes) {
  const current = forma.get('.gitignore');
  if (!current) return;
  const topOf = (ruta) => (ruta.includes('/') ? ruta.slice(0, ruta.indexOf('/')) : null);
  const shipped = new Set([...forma.keys()].map(topOf).filter(Boolean));
  const folders = [...new Set(FUENTES.flatMap((f) => ctx.arboles[f].map((e) => topOf(e.ruta))).filter((d) => d && !shipped.has(d)))].sort(porCodigo);
  if (!folders.length) return;
  const unwritable = folders.filter((d) => /[\r\n]/.test(d));
  if (unwritable.length) throw new NoPudo(`.gitignore: la carpeta ${JSON.stringify(unwritable[0])} no sale en la copia y su nombre trae un salto de línea: no se puede escribir en un .gitignore`);
  // En Mac y en Windows git aplica el .gitignore sin distinguir mayúsculas: la línea de una carpeta privada que sólo
  // difiere en la caja de una que SALE ignoraría la pública entera. No hay línea que ignore una sin la otra: se frena
  // (`caseCollisions` no lo ve: mira sólo las rutas que salen).
  const byFold = new Map([...shipped].map((d) => [d.toLowerCase(), d]));
  const clash = folders.find((d) => byFold.has(d.toLowerCase()));
  if (clash) throw new NoPudo(`.gitignore: la carpeta ${clash}/ no sale en la copia y sólo difiere en mayúsculas de ${byFold.get(clash.toLowerCase())}/, que sale: en un disco que no distingue la caja, ignorar una ignora la otra`);
  // El bloque va ENTERO y al final, diga lo que diga el .gitignore: en un .gitignore gana la última línea que coincide,
  // así que sólo al final le gana a un «!…» de más arriba (las «!…» se quitan solas sólo bajo una exclusión fija). Una
  // carpeta que el repo ya ignoraba —con otra línea o con la misma— se escribe igual: saltearla la dejaría a merced de
  // una negación posterior, y haría que la copia de dos repos físicos y la del repo unido llevaran bloques distintos.
  // Y va pegado a los BYTES que había, sin pasarlos por texto: lo que no es UTF-8 queda como estaba.
  const body = current.datos;
  const glue = body.length === 0 || body[body.length - 1] === 0x0a ? [] : [Buffer.from('\n')];
  const block = Buffer.from(`${[...PRIVATE_FOLDERS_NOTE, ...folders.map(rootFolderLine)].join('\n')}\n`, 'utf8');
  forma.set('.gitignore', { ...current, datos: Buffer.concat([body, ...glue, block]) });
  ajustes.push({ transformacion: 'gitignore-publico', archivo: `${current.fuente || 'arnes'}/.gitignore`,
    detalle: `ignora ${folders.length} carpeta(s) de primer nivel de las que no sale nada: ${folders.join(' ')}` });
}

/**
 * El filtrado del paso 4: qué archivos de los árboles salen en el paquete P —«in» − fijas − afuera
 * − afuera privado − revisores de otro paquete − suites y casos fuera— y qué deja en «pendientes». No lee contenidos
 * salvo los manifiestos de los paquetes y los archivos que declaran pendientes. Lo usan el exportador y `whatShips`.
 */
/**
 * Los nombres viejos del mapa de renombres a inglés, leído del árbol del arnés: las rutas viejas de
 * archivos y carpetas, por fuente. Sus reemplazos no viajan (la copia nace con los nombres nuevos) y ningún archivo que
 * sale puede nombrarlas. Sin mapa, nada. Un mapa que no se deja leer no es «sin nombres viejos»: no hay copia.
 */
const MAPA_RENOMBRES = 'scripts/lib/renames.json';
const NO_MAP_NOTE = 'sin mapa: no hay rutas viejas que reescribir';
function nombresViejos(ctx) {
  if (ctx.nombresViejos) return ctx.nombresViejos;
  // `todas`: cada ruta vieja de archivo o carpeta que el mapa nombra, movida o no (un reemplazo cuya
  // ruta no está acá no tiene entrada en el mapa)
  const r = { archivos: new Set(), carpetas: [], rutas: [], todas: [] };
  const e = ctx.arboles.arnes.find((x) => x.ruta === MAPA_RENOMBRES);
  if (e) {
    let mapa;
    try { mapa = JSON.parse(leerObjetos(ctx.repos.arnes, [e.obj]).get(e.obj).toString('utf8')); } catch (err) {
      // La foto de ANTES de un freno (`estricto: false`) no se traba por un mapa roto: si no, el commit que lo arregla
      // tampoco entraría. El exportador y la foto de después sí frenan.
      if (ctx.estricto === false) {
        process.stderr.write(`⚠️  ${MAPA_RENOMBRES} de la foto anterior no se deja leer (${err.message}): la miro sin nombres viejos\n`);
        ctx.nombresViejos = r;
        return r;
      }
      throw new NoPudo(`${MAPA_RENOMBRES} no se deja leer (${err.message}): sin el mapa no sé qué nombres viejos no viajan`);
    }
    for (const x of Array.isArray(mapa && mapa.entries) ? mapa.entries : []) {
      if (!x || (x.kind !== 'file' && x.kind !== 'folder') || typeof x.old !== 'string' || !x.old || typeof x.new !== 'string' || !x.new) continue;
      const fuente = x.repo === 'agent-skills' ? 'agent-skills' : 'arnes';
      const viejo = x.old.replace(/\/+$/, '');
      const nuevo = x.new.replace(/\/+$/, '');
      r.todas.push({ fuente, ruta: viejo, carpeta: x.kind === 'folder' });
      // sólo lo ya movido: el nuevo está en el árbol y el viejo ya no es el de verdad (no está, o es sólo reemplazos). Una
      // entrada todavía no movida nombra el archivo REAL, que sale; y la carpeta nueva puede existir antes de que la vieja
      // se mude (un archivo renombrado puede ir directo a su destino final)
      const arbol = ctx.arboles[fuente] || [];
      const hayNuevo = x.kind === 'file' ? arbol.some((a) => a.ruta === nuevo) : arbol.some((a) => a.ruta.startsWith(`${nuevo}/`));
      if (!hayNuevo) continue;
      const delViejo = arbol.filter((a) => a.tipo === 'blob' && (x.kind === 'file' ? a.ruta === viejo : a.ruta.startsWith(`${viejo}/`)));
      if (delViejo.length) {
        const legacy = require('../lib/legacy-names.js');
        const datos = leerObjetos(ctx.repos[fuente], delViejo.filter((a) => legacy.supportsShim(a.ruta)).map((a) => a.obj));
        if (delViejo.some((a) => !datos.has(a.obj) || !legacy.isShim(datos.get(a.obj).toString('utf8')))) continue;
      }
      if (x.kind === 'file') r.archivos.add(`${fuente}/${viejo}`);
      else r.carpetas.push(`${fuente}/${viejo}/`);
      // los archivos de su repo donde el nombre viejo es OTRO archivo que se llama igual; su forma la
      // valida `spanish-names.js --check-map`, acá sólo se usan los globs que son texto
      const homonimos = (Array.isArray(x.homonyms) ? x.homonyms : []).map((h) => h && h.glob).filter((g) => typeof g === 'string' && g);
      // una carpeta de un solo pedazo que el OTRO repo no llama (su `callers` no trae `other-repo`): allá, la palabra con
      // barra es prosa o una rama, no esta carpeta (ver `rutaViejaAjenaRe`)
      const ajenaSoloTrasLaRaiz = x.kind === 'folder' && !viejo.includes('/') && !(Array.isArray(x.callers) && x.callers.includes('other-repo'));
      r.rutas.push({ fuente, ruta: viejo, nueva: nuevo, carpeta: x.kind === 'folder', homonimos, ajenaSoloTrasLaRaiz });
    }
  }
  ctx.nombresViejos = r;
  return r;
}
/** Los archivos que salen y nombran una ruta vieja completa (fuera de la guía de la convención, que la explica). */
// La ruta vieja completa: delante, o nada que sea parte de una ruta, o la raíz del repo escrita de alguna forma
// (`tycon-claude-guides/`, `arnes/`, `$TCG/`, `${TCG}/`, `agent-skills/`, el `<arnés>/` con que la nombran las skills, o
// cualquier variable de shell que se cierra justo antes, `${TYCON_GUIDES_DIR:-…}/` — incluida `<arnés>/scripts/metrics/…`): otra ruta que TERMINA igual (un archivo de agent-skills)
// no es la vieja. La `\` vale lo mismo que la `/`: `scripts\<vieja>\` o la
// nueva `inbox\<vieja>\` escritas a la Windows son otra ruta que termina igual, y detrás de la raíz (`…\tycon-claude-guides\`,
// también con `\\` dentro de un string) es la vieja. Con eso el exportador decide como `spanish-names.js --stale-mentions`
// sin su exención por «otra ruta real del repo» (`completesOtherRealPath`): acá ninguna mención detrás de una barra cuenta,
// salvo detrás de la raíz, donde el pedazo siguiente es de primer nivel y no completa otra ruta.
// Los marcadores entre `<…>`: las skills y los agentes escriben la raíz como
// `<arnés>/` y también `<tcg>/` (el capturador de la retro: `node <tcg>/scripts/…`), y por extensión `<TCG>/`, `<arnes>/`,
// `<tycon-claude-guides>/` y `<agent-skills>/`. Una lista cerrada, no cualquier `<…>/`: `<repo>/`, `<clon>/` o `<árbol>/`
// pueden ser el repo de un producto con su propio `scripts/`, y traducirlas sería inventar. Un marcador nuevo que nombre
// al arnés se suma acá, con su caso en export.test.js (T19f).
const MARCADORES_DE_RAIZ = '<(?:arn[eé]s|tcg|TCG|tycon-claude-guides|agent-skills)>';
// La raíz del arnés escrita también como el LUGAR: `~/.claude/<lugar>/scripts/<viejo>` es la misma
// ruta vieja que detrás del nombre viejo. El nombre sale de place.js, la primera vez que se usa (quien carga este archivo
// sólo para un lector no la necesita); sin place.js, la raíz es el nombre clásico.
let placeRootAlt = null;
function PLACE_ROOT() {
  if (placeRootAlt === null) {
    try { placeRootAlt = `${require('../setup/harness/place.js').PLACE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|`; } catch (_) { placeRootAlt = ''; }
  }
  return placeRootAlt;
}
const ANTES_DE_RUTA = () => `(?:(?<![\\w.\\/\\\\-])|(?<=(?:tycon-claude-guides|${PLACE_ROOT()}arnes|\\$TCG|\\$\\{TCG\\}|agent-skills|${MARCADORES_DE_RAIZ}|\\})(?:\\/|\\\\{1,2})))`;
// Detrás: una carpeta vieja de UN solo pedazo es también una palabra común (la de los instintos:
// «propone …», «Revisar y accionar …» en la descripción de una skill), así que cuenta sólo escrita como ruta, con una barra
// detrás; sin esto la prosa frenaría la copia y, en el otro repo, se «traduciría» a `inbox/…`. Las de varios pedazos cuentan igual.
// Qué es una barra detrás (una `\` de escape, `\n` o `\t`, no lo es) lo dice una sola regla, la de spanish-names.js.
const DESPUES_DE_RUTA = (v) => (!v.carpeta ? '(?![\\w.@+~/-])' : v.ruta.includes('/') ? '(?![\\w.@+~-])' : require('./spanish-names.js').PATH_SEP_AHEAD);
const rutaViejaRe = (v, flags) => new RegExp(`${ANTES_DE_RUTA()}${v.ruta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${DESPUES_DE_RUTA(v)}`, flags);
// Entre repos, el nombre suelto de un archivo de la RAÍZ (sin carpeta) cuenta sólo detrás de la raíz del arnés escrita:
// solo, en el otro repo, es casi siempre otro archivo que se llama igual —el pipeline de cada producto se llama como el
// nocturno de métricas de `pipelines/`; la copia lo «traduciría» en un revisor y en una skill—. Detrás de `<arnés>/`, `$TCG/` o `tycon-claude-guides/` sí es el del arnés.
const ANTES_SOLO_RAIZ = () => `(?<=(?:tycon-claude-guides|${PLACE_ROOT()}arnes|\\$TCG|\\$\\{TCG\\}|agent-skills|${MARCADORES_DE_RAIZ}|\\})(?:\\/|\\\\{1,2}))`;
const deLaRaiz = (v) => !v.carpeta && !v.ruta.includes('/');
// Lo mismo para una carpeta de UN solo pedazo cuya entrada del mapa no declara al otro repo como llamador (`callers` sin
// `other-repo`; lo marca `nombresViejos`): con la barra detrás se sigue escribiendo igual que la prosa («regla de <x>/config
// descartada») y que las ramas de una cola (`<x>/<id>`), y en el otro repo no hay `homonyms` que lo digan. Sin esto,
// la prosa de un revisor reescrita a la carpeta nueva pasaría con la copia en 0. Con `other-repo` declarado se traduce como siempre; sin él, sólo detrás de la raíz.
const rutaViejaAjenaRe = (v, flags) => (deLaRaiz(v) || v.ajenaSoloTrasLaRaiz === true
  ? new RegExp(`${ANTES_SOLO_RAIZ()}${v.ruta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${DESPUES_DE_RUTA(v)}`, flags)
  : rutaViejaRe(v, flags));

const FOTOS_DE_PRODUCTO = /^arnes\/scripts\/tests\/fixtures\/product-pipeline\//;
function mencionesViejas(textos, viejos) {
  const hallazgos = [];
  if (!viejos.rutas.length) return hallazgos;
  const res = viejos.rutas.map((v) => ({ ...v, re: rutaViejaRe(v), reAjena: rutaViejaAjenaRe(v) }));
  // los que leen y protegen los dos nombres a propósito (escritura doble): la misma lista que exceptúa
  // `spanish-names.js --stale-mentions`, leída de ahí para que las dos no se separen. Sin esto, la
  // copia del núcleo no sale.
  const lectores = require('./spanish-names.js').LEGACY_READERS;
  for (const [clave, texto] of textos) {
    if (clave === 'arnes/guides/maintaining/nombres-en-ingles.md') continue;
    if (clave.startsWith('arnes/') && lectores.has(clave.slice('arnes/'.length))) continue;
    // la foto de un pipeline de producto real nombra los guiones viejos a propósito: los productos no se tocan hasta el
    // retiro y T32 corre esas líneas así (`--stale-mentions` la exceptúa igual, en STALE_ZONES). Sin esto, la copia del
    // núcleo no sale mientras se muden guiones que llaman los productos.
    if (FOTOS_DE_PRODUCTO.test(clave)) continue;
    // en su propio repo, una entrada no cuenta en sus archivos `homonyms`; en el otro repo, el nombre suelto de la raíz
    // cuenta sólo detrás de la raíz del arnés
    // la traducción a Codex de un agente de agent-skills es texto de agent-skills (lo regenera build/check.js desde el
    // agente): para la regla entre repos, cuenta como del otro repo
    // dos fuentes distintas: la del ARCHIVO (dónde vive: contra ella se miran los globs de homonyms, que son rutas de su
    // repo) y la del TEXTO (de quién es: decide si una mención es del propio repo o de otro)
    const repoDelArchivo = clave.startsWith('agent-skills/') ? 'agent-skills' : 'arnes';
    const rel = clave.slice(repoDelArchivo.length + 1);
    const fuente = repoDelArchivo === 'agent-skills' || CODEX_TOML.test(clave) ? 'agent-skills' : 'arnes';
    // `homonimos` lo arma nombresViejos(); quien llama a mencionesViejas con sus propias rutas (las pruebas) puede no
    // traerlo: sin lista, no hay homónimos
    // Las dos expresiones exigen la ruta vieja escrita tal cual (sin `i`): un archivo o una línea que no la contiene no
    // puede dar hallazgo. Mirarlo antes evita la expresión en casi todo —sin el atajo pesaría casi la mitad de cada exportación del
    // núcleo, y la validación de un cambio hace varias—. El orden de los hallazgos no cambia: línea por línea y, en cada una, las rutas en el orden de `aplican`.
    const enTexto = res.filter((v) => texto.includes(v.ruta) && (v.fuente !== repoDelArchivo || !(v.homonimos || []).some((g) => coincide(g, rel))));
    if (!enTexto.length) continue;
    texto.split(/\r?\n/).forEach((linea, i) => {
      for (const v of enTexto) if (linea.includes(v.ruta) && (v.fuente === fuente ? v.re : v.reAjena).test(linea)) hallazgos.push({ archivo: clave, linea: i + 1, ruta: v.ruta });
    });
  }
  return hallazgos;
}

// `P` es un paquete o una lista (la unión). En la unión un archivo sale si sale en alguno de los
// paquetes pedidos, y los revisores de los pedidos salen ENTEROS (sus superficies del arnés salen con el núcleo); los de un
// paquete fuera de la lista no salen. Un paquete solo: el .md de sus revisores y el resto, pendiente de la
// unión con el núcleo.
function filterPackage(ctx, P) {
  const pedidos = packageList(P);
  const union = pedidos.length > 1;
  const enArbol = (f, ruta) => ctx.arboles[f].find((e) => e.ruta === ruta);
  const viejos = nombresViejos(ctx);
  const porPaquete = revisoresDePaquete(ctx);
  const propios = new Set();
  for (const p of pedidos) for (const a of porPaquete.get(p) || []) propios.add(a);
  const ajenos = new Set();
  for (const [p, agentes] of porPaquete) if (!pedidos.includes(p)) for (const a of agentes) if (!propios.has(a)) ajenos.add(a);
  // solo, las superficies compartidas no llevan a ninguno de los dos; en la unión, las de los pedidos salen enteras
  const quitarRevisores = union ? new Set(ajenos) : new Set([...ajenos, ...propios]);
  const fueraPorSuite = new Map();
  for (const s of ctx.lista.suitesOutside || []) fueraPorSuite.set(`${s.root}/${s.root === 'arnes' ? 'scripts' : 'skills'}/${s.path}`, s);
  const fueraPorCaso = new Map((ctx.lista.casesOutside || []).map((c) => [`arnes/${c.path}`, c]));
  const ajustes = [];
  const pendientes = [];
  const incluidos = [];
  const excluidosFijos = {};
  for (const f of FUENTES) {
    const defs = pedidos.map((p) => ctx.lista.packages[p][f] || { in: [], out: [] });
    const fijas = EXCLUIDOS_SIEMPRE.filter((x) => x.fuente === f);
    const privado = ctx.afueraPrivado.filter((x) => x.fuente === f);
    const superficies = new Map();
    for (const a of quitarRevisores) for (const [sf, s] of superficiesDeArchivo(a)) if (sf === f) superficies.set(s, a);
    excluidosFijos[f] = 0;
    for (const e of ctx.arboles[f]) {
      const toman = defs.filter((d) => (d.in || []).some((g) => coincide(g, e.ruta)));
      if (!toman.length) continue;
      const clave = `${f}/${e.ruta}`;
      if (fijas.some((x) => cubreFija(x, e.ruta))) { excluidosFijos[f]++; continue; }
      if (viejos.archivos.has(clave) || viejos.carpetas.some((c) => clave.startsWith(c))) {
        ajustes.push({ transformacion: 'nombres-viejos', archivo: clave, detalle: 'reemplazo de un nombre viejo (story 8.9): la copia nace con los nombres nuevos' });
        continue;
      }
      // afuera si lo dejan afuera todos los paquetes pedidos que lo toman
      if (toman.every((d) => (d.out || []).some((x) => coincide(x.glob, e.ruta)))) continue;
      if (privado.some((x) => coincide(x.glob, e.ruta))) continue;
      const otroPaquete = /^packs\/([^/]+)\//.exec(e.ruta);
      if (f === 'agent-skills' && otroPaquete && !pedidos.includes(otroPaquete[1])) continue;
      const revisor = superficies.get(e.ruta);
      if (revisor && !(propios.has(revisor) && e.ruta === `agents/${revisor}.md`)) {
        ajustes.push({ transformacion: 'revisores-de-paquete', archivo: clave, detalle: `superficie del revisor ${revisor}, que no sale en este paquete` });
        continue;
      }
      if (fueraPorSuite.has(clave)) {
        ajustes.push({ transformacion: 'suites-y-casos-fuera', archivo: clave, detalle: `suite fuera (${fueraPorSuite.get(clave).path}): ${fueraPorSuite.get(clave).reason}` });
        continue;
      }
      if (fueraPorCaso.has(clave)) {
        ajustes.push({ transformacion: 'suites-y-casos-fuera', archivo: clave, detalle: `caso del banco fuera: ${fueraPorCaso.get(clave).reason}` });
        continue;
      }
      incluidos.push({ fuente: f, ...e, clave });
    }
    // la salida (los pendientes) conserva sus claves: sólo cambian las de la lista
    for (const d of defs) {
      for (const x of d.out || []) {
        if (x.until && !pendientes.some((y) => y.ruta === `${f}/${x.glob}`)) pendientes.push({ ruta: `${f}/${x.glob}`, hasta: String(x.until) });
      }
    }
  }
  // pendientes: lo de los revisores de un paquete exportado SOLO, que sale entero en la unión con el núcleo
  // (cada pendiente nombra esa unión)
  const UNTIL_UNION = ['core', ...pedidos.filter((p) => p !== 'core')].join(',');
  if (!union && propios.size) {
    const leerArnes = (ruta) => {
      const e = enArbol('arnes', ruta);
      return e ? leerObjetos(ctx.repos.arnes, [e.obj]).get(e.obj).toString('utf8') : null;
    };
    const manifiesto = leerArnes(MANIFIESTO_CODEX);
    const catalogo = leerArnes(CATALOGO);
    const lineasBase = ctx.arboles.arnes.filter((e) => LINEA_BASE.test(e.ruta)).map((e) => [e.ruta, leerArnes(e.ruta)]);
    for (const a of [...propios].sort(porCodigo)) {
      for (const [sf, s] of superficiesDeArchivo(a)) if (sf === 'arnes' && enArbol('arnes', s)) pendientes.push({ ruta: `arnes/${s}`, hasta: UNTIL_UNION });
      if (manifiesto && (JSON.parse(manifiesto).advisors || []).includes(a)) pendientes.push({ ruta: `arnes/${MANIFIESTO_CODEX}#${a}`, hasta: UNTIL_UNION });
      for (const [ruta, texto] of lineasBase) {
        const cases = (JSON.parse(texto) || {}).cases || {};
        if (Object.keys(cases).some((k) => k.startsWith(`${a}::`))) pendientes.push({ ruta: `arnes/${ruta}#${a}::*`, hasta: UNTIL_UNION });
      }
      if (catalogo && seccionesDe(catalogo).has(a)) pendientes.push({ ruta: `arnes/${CATALOGO}#${a}`, hasta: UNTIL_UNION });
    }
  }
  return { incluidos, ajustes, pendientes: pendientes.sort((a, b) => porCodigo(a.ruta, b.ruta)), excluidosFijos, quitarRevisores, propios };
}

function transformar(ctx, copia, quitarRevisores, ajustes, P = ctx.paquete) {
  const texto = (clave) => copia.get(clave).datos.toString('utf8');
  const poner = (clave, t) => { copia.get(clave).datos = Buffer.from(t, 'utf8'); };

  const manifiesto = `arnes/${MANIFIESTO_CODEX}`;
  if (copia.has(manifiesto)) {
    const t = texto(manifiesto);
    const nodo = miembro(analizarJson(t), 'advisors');
    if (nodo && nodo.valor.tipo === 'arreglo') {
      const nombres = JSON.parse(t).advisors;
      // Queda en el manifiesto sólo el revisor cuyo .md sale: si no, build/generate.js no lo puede regenerar (o
      // regeneraría la traducción de un revisor que la lista dejó afuera). Sus traducciones se van con él.
      const conMd = (n) => copia.has(`agent-skills/agents/${n}.md`);
      const quedan = nombres.map((n, i) => i).filter((i) => !quitarRevisores.has(nombres[i]) && conMd(nombres[i]));
      if (quedan.length !== nombres.length) {
        const fuera = nombres.filter((n, i) => !quedan.includes(i));
        poner(manifiesto, dejarHijos(t, nodo.valor, quedan));
        ajustes.push({ transformacion: 'manifiesto-codex', archivo: manifiesto, detalle: `sin ${fuera.join(', ')}` });
        for (const n of fuera) {
          for (const toml of [`arnes/adapters/codex/agents/${n}.toml`, `arnes/adapters/codex/agents-native/${n}.toml`]) {
            if (copia.delete(toml)) ajustes.push({ transformacion: 'manifiesto-codex', archivo: toml, detalle: `traducción de ${n}, que no sale` });
          }
        }
      }
    }
  }

  // Un caso del banco que no sale (casesOutside) se lleva sus entradas de la línea base: `<script>::<id>`, la misma
  // clave que arma controls-bench/runner.js. Sin esto la copia queda con entradas huérfanas.
  const clavesFuera = new Set();
  for (const c of ctx.lista.casesOutside || []) {
    const e = ctx.arboles.arnes.find((x) => x.ruta === c.path);
    let def;
    try {
      def = JSON.parse(leerObjetos(ctx.repos.arnes, [e.obj]).get(e.obj).toString('utf8'));
    } catch (err) {
      throw new NoPudo(`casesOutside: ${c.path} no es JSON válido (${err.message})`);
    }
    for (const h of Array.isArray(def.hooks) ? def.hooks : [def]) {
      for (const caso of (h && h.cases) || []) clavesFuera.add(`${path.posix.basename(String(h.script || h.hook))}::${caso.id}`);
    }
  }
  for (const clave of [...copia.keys()].filter((k) => k.startsWith('arnes/') && LINEA_BASE.test(k.slice(6))).sort(porCodigo)) {
    const t = texto(clave);
    const nodo = miembro(analizarJson(t), 'cases');
    if (!nodo || nodo.valor.tipo !== 'objeto') continue;
    const quitar = (k) => clavesFuera.has(k) || [...quitarRevisores].some((a) => k.startsWith(`${a}::`));
    const quedan = nodo.valor.hijos.map((h, i) => i).filter((i) => !quitar(nodo.valor.hijos[i].clave));
    if (quedan.length !== nodo.valor.hijos.length) {
      poner(clave, dejarHijos(t, nodo.valor, quedan));
      ajustes.push({ transformacion: 'linea-base-banco', archivo: clave, detalle: `${nodo.valor.hijos.length - quedan.length} entrada(s) de revisores o casos que no salen` });
    }
  }

  const catalogo = `arnes/${CATALOGO}`;
  if (copia.has(catalogo)) {
    const r = quitarSecciones(texto(catalogo), quitarRevisores);
    if (r.quitadas.size) {
      poner(catalogo, r.texto);
      ajustes.push({ transformacion: 'catalogo-de-reglas', archivo: catalogo, detalle: `sin las secciones de ${[...r.quitadas].sort(porCodigo).join(', ')}` });
    }
  }

  const suites = 'arnes/scripts/tests/suites.json';
  if (copia.has(suites)) {
    const fuera = new Set((ctx.lista.suitesOutside || []).map((s) => `${s.root}:${s.path}`));   // las de suites.json: raiz/ruta
    for (const familia of ['diarias', 'semanales']) {
      const t = texto(suites);
      const nodo = miembro(analizarJson(t), familia);
      if (!nodo || nodo.valor.tipo !== 'arreglo') continue;
      const entradas = JSON.parse(t)[familia];
      const quedan = [];
      entradas.forEach((e, i) => {
        const archivo = e && e.raiz && e.ruta ? `${e.raiz}/${e.raiz === 'arnes' ? 'scripts' : 'skills'}/${e.ruta}` : null;
        if (archivo && (fuera.has(`${e.raiz}:${e.ruta}`) || !copia.has(archivo))) {
          ajustes.push({ transformacion: 'suites-json', archivo: suites, detalle: `sin la entrada ${e.raiz}:${e.ruta} (${fuera.has(`${e.raiz}:${e.ruta}`) ? 'suitesOutside' : 'su archivo no sale'})` });
        } else quedan.push(i);
      });
      poner(suites, dejarHijos(t, nodo.valor, quedan));
    }
  }

  // El registro de las suites partidas: scripts/tests/suite-parts.json nombra el archivo ENTERO de cada una.
  // La entrada de una suite que no viaja se va con ella, igual que su entrada de suites.json: si quedara, dentro de la
  // copia la suite figuraría «partida» sin estar, y suites-coverage y suite-parts darían rojo (heavy-suites.test.js lo
  // ve; en el repo del equipo todo seguiría verde). Un registro que no se deja leer no se publica.
  const registroDePartes = `arnes/${REGISTRO_DE_PARTES}`;
  if (copia.has(registroDePartes)) {
    const fuera = new Set((ctx.lista.suitesOutside || []).filter((s) => s.root === 'arnes').map((s) => s.path));
    const t = texto(registroDePartes);
    let nombres;
    let nodo;
    try {
      const leido = JSON.parse(t).suites;
      nodo = miembro(analizarJson(t), 'suites');
      if (!leido || typeof leido !== 'object' || Array.isArray(leido) || !nodo || nodo.valor.tipo !== 'objeto') throw new Error('no trae «suites» como objeto');
      nombres = nodo.valor.hijos.map((h) => h.clave);
    } catch (e) {
      throw new NoPudo(`${REGISTRO_DE_PARTES} del arnés no se deja leer (${e.message}): la copia no lo lleva a medias`);
    }
    const quedan = [];
    nombres.forEach((nombre, i) => {
      if (fuera.has(`tests/${nombre}`) || !copia.has(`arnes/scripts/tests/${nombre}`)) {
        ajustes.push({ transformacion: 'suite-parts-json', archivo: registroDePartes, detalle: `sin la entrada ${nombre} (la suite no viaja)` });
      } else quedan.push(i);
    });
    poner(registroDePartes, dejarHijos(t, nodo.valor, quedan));
  }

  // (`vaciar` y `sinteticos`, abajo, son ids de transformación de la salida: no cambian con las claves de la lista)
  for (const [archivo, claves] of Object.entries(ctx.lista.empty || {})) {
    if (archivo.startsWith('__')) continue;
    const clave = `arnes/${archivo}`;
    if (!copia.has(clave)) continue;
    for (const k of claves) {
      const t = texto(clave);
      const nodo = miembroPorRuta(analizarJson(t), k);
      if (!nodo) throw new NoPudo(`empty: ${archivo} no tiene la clave «${k}»`);
      const v = nodo.valor;
      const vacio = v.tipo === 'objeto' ? '{}' : v.tipo === 'arreglo' ? '[]' : t[v.ini] === '"' ? '""' : 'null';
      poner(clave, t.slice(0, v.ini) + vacio + t.slice(v.fin));
      ajustes.push({ transformacion: 'vaciar', archivo: clave, detalle: `«${k}» vacía (dato del equipo)` });
    }
  }

  // el texto exacto que manda a una integración del equipo pasa a su versión pública. Antes de los
  // reemplazos de nombres: el texto declarado es el del repo, tal cual.
  const publicos = ctx.lista.publicTexts || [];
  for (const clave of new Set(publicos.map((e) => `${e.root}/${e.file}`))) {
    if (!copia.has(clave)) continue;   // el archivo no sale en este paquete
    poner(clave, applyPublicTexts(clave, texto(clave), publicos));
    for (const e of publicos.filter((x) => `${x.root}/${x.file}` === clave)) ajustes.push({ transformacion: 'public-texts', archivo: clave, detalle: e.reason });
  }

  for (const f of FUENTES) {
    const clave = `${f}/.gitignore`;
    if (!copia.has(clave)) continue;
    const lineas = texto(clave).split('\n');
    // en el repo unido el .gitignore es uno, el de las dos fuentes: se mira contra las fijas de las dos
    const owners = ctx.unified === true ? FUENTES : [f];
    const dropped = (l) => l.startsWith('!') && owners.some((x) => bajoFija(l.slice(1).trim(), x));
    const quitadas = lineas.filter(dropped);
    if (quitadas.length) {
      poner(clave, lineas.filter((l) => !dropped(l)).join('\n'));
      ajustes.push({ transformacion: 'gitignore-publico', archivo: clave, detalle: `sin ${quitadas.length} línea(s) «!…» bajo una exclusión fija: ${quitadas.join(' ')}` });
    }
  }

  // desde el repo unido, en la copia de dos repos cada parte del pre-commit vuelve a su repo (`splitHooks`).
  // Va acá —y no sólo en la exportación— para que la clasificación (`whatShips`) de un contexto armado por
  // `prepararFuentes` diga lo mismo que la copia de dos repos; los frenos de nombres arman su propio contexto, sin
  // `unified`, y siguen viendo los archivos del repo tal cual.
  if (ctx.unified === true && !ctx.singleRepo) splitHooks(copia, ajustes);

  // en este orden: skill-rename → public-third-party → los sintéticos con sus marcadores → internal-blocks.
  // Todo antes de regenerar las traducciones a Codex (una .toml copia el texto de su .md) y de los controles.
  ctx.renamed = [];
  for (const regla of ctx.lista.skillRenames || []) if (regla.from !== regla.to) renameSkillInCopy(ctx, copia, regla, ajustes);
  const terceros = `arnes/${MANIFIESTO_TERCEROS}`;
  if (copia.has(terceros)) {
    // una skill es la carpeta que tiene su SKILL.md, a cualquier profundidad: `skills/core/<x>/SKILL.md` es «x», no «core»
    const skills = new Set([...copia.keys()].map((k) => /^agent-skills\/skills\/(?:[^/]+\/)*?([^/]+)\/SKILL\.md$/.exec(k)).filter(Boolean).map((m) => m[1]));
    let r;
    try {
      r = publicCopy.publicThirdParty(texto(terceros), skills);
    } catch (e) {
      throw new NoPudo(`${MANIFIESTO_TERCEROS} (public-third-party): ${e.message}`);
    }
    if (r.removed.length) {
      poner(terceros, r.text);
      ajustes.push({ transformacion: 'public-third-party', archivo: terceros, detalle: `en third_party quedan ${r.kept.length} (las que usa algo que sale o traen publish: true, con licencia libre) y salen ${r.removed.length}` });
    }
  }
  // los papeles se ponen ANTES de internal-blocks: un papel .md también pierde sus bloques internos, y un marcador en uno
  // que no es .md sale 2
  placeSynthetics(ctx, copia, ajustes, P);
  // Para los frenos de nombres (`whatShips`) el .md se mira ENTERO, bloques internos incluidos: un nombre real
  // dentro de un bloque interno sigue en el interno, y el freno lo tiene que ver
  if (!ctx.classifying) applyInternalBlocks(copia, ajustes);
}

/** Las formas con que las skills y las guías nombran un archivo del arnés instalado: los mismos reconocedores que usa el
 *  control de comandos colgados (`PREFIJOS_COMANDO`: el lugar por sus dos nombres, la variable del arnés y la carpeta de
 *  las skills), con lo que queda como ruta desde la raíz del repo. Pares `[expresión, prefijo que queda]`. */
function installPrefixes() {
  // Como PLACE_ROOT: el exportador sacado de OTRO commit (la sincronización, que lo corre desde una carpeta suelta) puede no
  // tener al lado el módulo del lugar. Sin él no hay prefijos que reconocer —esas rutas quedan sin marca—;
  // cualquier otro error sube.
  try {
    return PREFIJOS_COMANDO().map(([re, pre]) => [re, pre.replace(/^(?:arnes|agent-skills)\//, '')]);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return [];
    throw e;
  }
}

/**
 * pathsNotInCopy: su propia cuenta de las rutas que tendrían que llevar la marca y no la llevan —no
 * llama a `markPathsNotInCopy`: decide por su cuenta qué es una ruta del equipo—. Lee el código en línea con el mismo
 * lector que la marca (`proseCodeSpans`, CommonMark): si leyeran distinto, el control frenaría algo que la marca no puede
 * arreglar. `textos`: pares `[ruta desde la raíz de su repo, texto]`. Devuelve
 * `{ archivo, linea, ruta }`.
 */
function pathsNotInCopy(textos, { inRepo, inCopy, conventions = [], installPrefixes = [] }) {
  const MARCA = publicCopy.NOT_IN_COPY_MARK;
  const convencion = (p) => conventions.some((c) => (c.endsWith('/') ? p === c.slice(0, -1) || p.startsWith(c) : p === c));
  const hallazgos = [];
  for (const [archivo, texto] of textos) {
    if (!/\.md$/i.test(archivo) || publicCopy.ROOT_DOCS.has(archivo) || typeof texto !== 'string') continue;
    const carpeta = path.posix.dirname(archivo);
    for (const s of publicCopy.proseCodeSpans(texto)) {
      let dicha = s.content.trim().split(/\s+/)[0] || '';
      // un prefijo de instalación: un texto con que empieza, o un par [expresión, prefijo que queda]
      const instalado = installPrefixes.find((x) => (typeof x === 'string' ? dicha.startsWith(x) : x[0].test(dicha)));
      const desdeLaRaiz = instalado !== undefined;
      if (desdeLaRaiz) dicha = typeof instalado === 'string' ? dicha.slice(instalado.length) : instalado[1] + dicha.replace(instalado[0], '');
      if (!dicha || /[<{*?`]/.test(dicha) || /^[a-z][a-z0-9+.-]*:\/\//i.test(dicha)) continue;
      const ruta = dicha.split('#')[0].replace(/:\d+(-\d+)?$/, '').replace(/^\.\//, '').replace(/\/+$/, '');
      if (!ruta || ruta.startsWith('/') || ruta.startsWith('~') || ruta.split('/').includes('..')) continue;
      if (dicha.includes('#') && ruta === 'guides/maintaining/incident-log.md') continue;
      const vecina = !desdeLaRaiz && carpeta !== '.' ? path.posix.normalize(`${carpeta}/${ruta}`) : null;
      if (inCopy(ruta) || (vecina && inCopy(vecina))) continue;
      // primero la vecina del archivo (gana sobre una convención suelta del mismo nombre); después, desde la raíz
      let delEquipo = null;
      if (vecina && inRepo(vecina) && !convencion(vecina)) delEquipo = vecina;
      else if (inRepo(ruta) && !convencion(ruta)) delEquipo = ruta;
      if (!delEquipo || texto.startsWith(MARCA, s.end)) continue;
      hallazgos.push({ archivo, linea: s.line, ruta: delEquipo });
    }
  }
  return hallazgos;
}

/** La ruta de origen de un archivo de la copia (`<fuente>/<ruta en su repo>`), aunque haya salido con otro nombre. */
const sourceKey = (clave, a) => (a && a.fuente && a.ruta ? `${a.fuente}/${a.ruta}` : clave);

/** skill-rename: la carpeta a su nombre nuevo y el identificador en cada texto que sale (public-copy.js). */
function renameSkillInCopy(ctx, copia, regla, ajustes) {
  const prefijo = `${regla.source}/${regla.from}/`;
  const movidas = [...copia.keys()].filter((k) => k.startsWith(prefijo)).sort(porCodigo);
  for (const clave of movidas) {
    const a = copia.get(clave);
    copia.delete(clave);
    copia.set(`${regla.source}/${regla.to}/${clave.slice(prefijo.length)}`, a);
  }
  if (movidas.length) ctx.renamed.push({ from: regla.from, to: regla.to });
  const viejo = path.posix.basename(regla.from);
  const nuevo = path.posix.basename(regla.to);
  for (const [clave, a] of copia) {
    if (CODEX_TOML.test(clave)) continue;   // se regeneran desde su .md, ya renombrado
    const datos = a.datos;
    if (detector.esBinario(datos) || !datos.includes(viejo)) continue;
    let r;
    try {
      r = publicCopy.renameSkill(datos.toString('utf8'), clave, regla);
    } catch (e) {
      throw new NoPudo(`skill-rename ${regla.from}: ${e.message}`);
    }
    if (!r.changed) continue;
    a.datos = Buffer.from(r.text, 'utf8');
    ajustes.push({ transformacion: 'skill-rename', archivo: sourceKey(clave, a), detalle: `«${viejo}» pasa a «${nuevo}» (${regla.reason})` });
  }
}

/** internal-blocks: saca los bloques internos de los .md; un marcador mal puesto, o fuera de un .md, es 2.
 *  Mira todo archivo con un comentario HTML. */
function applyInternalBlocks(copia, ajustes) {
  const errores = [];
  for (const [clave, a] of copia) {
    if (CODEX_TOML.test(clave)) continue;   // se regeneran desde su .md, que sí se mira
    const datos = a.datos;
    // sin filtro previo por texto: uno que pidiera «tycon:» dejaría salir un bloque con una errata en la palabra
    // del arnés, y un marcador puede quedar suelto, sin su comentario. Se mira todo archivo de texto.
    if (detector.esBinario(datos)) continue;
    const t = datos.toString('utf8');
    if (clave.toLowerCase().endsWith('.md')) {
      const r = publicCopy.internalBlocks(t, clave);
      if (r.errors.length) { errores.push(...r.errors.map((e) => `${e.file}:${e.line}: ${e.why}`)); continue; }
      if (!r.changed) continue;
      a.datos = Buffer.from(r.text, 'utf8');
      ajustes.push({ transformacion: 'internal-blocks', archivo: sourceKey(clave, a), detalle: 'sin sus bloques internos; los sólo-públicos, visibles' });
    } else {
      for (const m of publicCopy.markerLines(t)) errores.push(`${clave}:${m.line}: un marcador de bloque (${m.marker.trim()}) fuera de un .md — los bloques internos van sólo en los .md`);
    }
  }
  if (errores.length) throw new NoPudo(`marcadores de bloque mal puestos (internal-blocks):\n  · ${errores.sort(porCodigo).join('\n  · ')}`);
}

/**
 * Los sintéticos: con `packages`, en las exportaciones que
 * incluyen alguno; sin él, cuando un «in» del arnés de un paquete pedido cubre el destino. Nunca pisan algo que ya sale.
 * `{{public-org}}` y `{{public-repo}}` pasan al nombre público (si se conoce: el freno de nombres los mira sin él); otro
 * `{{public-…}}` es 2. Deja en `ctx.papers` el texto de cada `from` (para handWrittenPublicUrl) y en
 * `ctx.placedSynthetics` qué sintético puso qué destino (para que `whatShips` cuente su `from`).
 */
function placeSynthetics(ctx, copia, ajustes, P) {
  const pedidos = packageList(P);
  ctx.papers = [];
  ctx.placedSynthetics = [];
  for (const s of ctx.lista.synthetic || []) {
    const aplica = Array.isArray(s.packages)
      ? s.packages.some((p) => pedidos.includes(p))
      : pedidos.some((p) => (((ctx.lista.packages[p] || {}).arnes || {}).in || []).some((g) => coincide(g, s.target)));
    if (!aplica) continue;
    const clave = `arnes/${s.target}`;
    const pisa = FUENTES.map((f) => `${f}/${s.target}`).find((k) => copia.has(k));
    // Frenar es del exportador. La clasificación de los frenos de nombres (`whatShips`) arma también vistas que la copia
    // nunca tiene (la «efectiva», sin los afuera que agrega el commit): ahí el sintético ocupa su destino como siempre, y
    // lo que se mira es su contenido.
    if (pisa && !ctx.classifying) throw new NoPudo(`synthetic ${s.target} (desde ${s.from}): su destino ya sale (${pisa}) — un sintético nunca pisa algo que sale: elegí otro destino o sacá el otro con un «out»`);
    const e = ctx.arboles.arnes.find((x) => x.ruta === s.from && x.tipo === 'blob');
    if (!e) throw new NoPudo(`synthetic: ${s.from} no existe en el arnés`);
    let datos = Buffer.from(leerObjetos(ctx.repos.arnes, [e.obj]).get(e.obj));
    let conNombre = false;
    if (!detector.esBinario(datos)) {
      const t = datos.toString('utf8');
      const otros = [...new Set(t.match(PUBLIC_MARKER) || [])].filter((m) => m !== '{{public-org}}' && m !== '{{public-repo}}');
      if (otros.length) throw new NoPudo(`synthetic ${s.target} (desde ${s.from}): ${otros.join(', ')} no es un marcador que el exportador defina (sólo {{public-org}} y {{public-repo}})`);
      ctx.papers.push({ target: s.target, from: s.from, texto: t });
      if (ctx.publicRepo && t.includes('{{public-')) {
        datos = Buffer.from(t.split('{{public-org}}').join(ctx.publicRepo.org).split('{{public-repo}}').join(ctx.publicRepo.repo), 'utf8');
        conNombre = true;
      }
    }
    copia.set(clave, { fuente: 'arnes', ruta: s.target, modo: '100644', datos });
    ctx.placedSynthetics.push({ target: s.target, from: s.from, modo: e.modo, clave });
    ajustes.push({ transformacion: 'sinteticos', archivo: clave, detalle: `es el sintético ${s.from}: ${s.reason}` });
    if (conNombre) ajustes.push({ transformacion: 'public-name', archivo: clave, detalle: `{{public-org}}/{{public-repo}} → ${ctx.publicRepo.org}/${ctx.publicRepo.repo}` });
  }
}

// ── Qué sale, y con qué contenido: la clasificación, para el freno de nombres nuevos ─────────
// El freno (new-names.js) no reimplementa qué sale ni cómo se transforma: pregunta acá. Si el freno y la copia dijeran
// cosas distintas, uno de los dos mentiría (T25 y T27 los comparan). `ctx` trae lo que arma `prepararFuentes` —o lo
// mismo armado desde el índice de un commit—: lista, afueraPrivado, arboles y repos. No reemplaza nombres ni regenera
// las traducciones a Codex (se regeneran desde los .md, que sí se miran).
const publicPackages = (ctx) => Object.keys(ctx.lista.packages).filter((p) => !p.startsWith('__') && !PAQUETES_PRIVADOS.includes(p));

/** Lee objetos de git por lotes y los recuerda: la copia perezosa pide de a uno, la precarga de a muchos. */
function objectReader(ctx) {
  const cache = new Map();
  const read = (source, objs) => {
    const missing = [...new Set(objs)].filter((o) => !cache.has(`${source}\0${o}`));
    if (missing.length) for (const [o, b] of leerObjetos(ctx.repos[source], missing)) cache.set(`${source}\0${o}`, b);
    return (o) => cache.get(`${source}\0${o}`);
  };
  return read;
}

/** Una entrada de la copia cuyo contenido se lee recién cuando alguien lo pide (`transformar` toca pocos archivos). */
function lazyEntry(e, read) {
  let data = null;
  return {
    fuente: e.fuente, ruta: e.ruta, modo: e.modo, obj: e.obj,
    get datos() { if (data === null) data = read(e.fuente, [e.obj])(e.obj); return data; },
    set datos(v) { data = v; },
  };
}

/** Sólo las secciones del catálogo de los revisores dados (lo que un paquete deja en pendientes). */
function onlySections(text, agents) {
  const out = [];
  let inside = false;
  recorrerSecciones(text, (agent) => { inside = !!(agent && agents.has(agent)); }, (l) => { if (inside) out.push(l); });
  return out.join('\n');
}

/**
 * Por cada paquete PÚBLICO: sus archivos —`kind` copy (se mira), translation (una traducción a Codex: se regenera) o
 * synthetic (el destino de un `synthetic` de la lista: su contenido es otro archivo, que se mira en su ruta)—, sus pendientes (que
 * cuentan como que salen) y `content(clave)`, el contenido ya transformado como en la copia. `ofFile(fuente, ruta)`
 * junta lo que sale de un archivo: su texto en cada copia que lo lleva y lo que de él queda en pendientes.
 */
function whatShips(ctx) {
  const read = objectReader(ctx);
  const byPath = (f) => new Map(ctx.arboles[f].map((e) => [e.ruta, e]));
  const trees = Object.fromEntries(FUENTES.map((f) => [f, byPath(f)]));
  const synthetic = new Set((ctx.lista.synthetic || []).map((s) => `arnes/${s.target}`));
  // los papeles llevan el nombre público puesto, leído del MISMO commit que se clasifica. Si el commit
  // no trae el archivo (la copia pública no lo lleva), se miran con sus marcadores: no son nombres. Un archivo que está y
  // no se deja leer, o no es válido, sube: «no pude mirar» nunca es «sin nombre público».
  if (ctx.publicRepo === undefined) {
    const e = (ctx.arboles.arnes || []).find((x) => x.ruta === PUBLIC_REPOS && x.tipo === 'blob');
    if (!e) ctx.publicRepo = null;
    else {
      let datos;
      try { datos = JSON.parse(read('arnes', [e.obj])(e.obj).toString('utf8')); } catch (err) {
        throw new NoPudo(`el nombre público ${PUBLIC_REPOS} del commit no se deja leer (${err.message})`);
      }
      ctx.publicRepo = validarNombrePublico(datos, `${PUBLIC_REPOS} del commit`);
    }
  }
  const packages = publicPackages(ctx).sort(porCodigo).map((P) => {
    const f = filterPackage(ctx, P);
    const copia = new Map(f.incluidos.map((e) => [e.clave, lazyEntry(e, read)]));
    // transformar lee casi todo (los .md por sus bloques, cada texto por el renombre de una skill):
    // todo en un lote por fuente
    for (const fuente of FUENTES) read(fuente, [...copia.values()].filter((a) => a.fuente === fuente).map((a) => a.obj));
    ctx.classifying = true;
    try {
      transformar(ctx, copia, f.quitarRevisores, [...f.ajustes], P);
    } finally {
      ctx.classifying = false;
    }
    // Se regenera sólo la traducción de un revisor del manifiesto; un .toml que no está ahí sale tal cual, y se mira.
    // (un manifiesto ilegible ya lo rechazó `transformar`: acá llega sano, y si no, el error sube: «no pude mirar»)
    const man = copia.get(`arnes/${MANIFIESTO_CODEX}`);
    const regenerados = new Set(man ? (JSON.parse(man.datos.toString('utf8')).advisors || []) : []);
    const traduccion = (clave) => CODEX_TOML.test(clave) && regenerados.has(path.posix.basename(clave, '.toml'));
    const files = new Map([...copia.entries()].sort((a, b) => porCodigo(a[0], b[0])).map(([clave, a]) => [clave, {
      fuente: a.fuente, ruta: a.ruta, modo: a.modo,
      kind: traduccion(clave) ? 'translation' : synthetic.has(clave) ? 'synthetic' : 'copy',
    }]));
    // el `from` de cada sintético que aplica también sale —con el contenido de su destino—, así los
    // frenos de nombres miran un papel de public-files/ aunque esa carpeta no viaje
    const desde = new Map();
    for (const s of ctx.placedSynthetics || []) {
      const clave = `arnes/${s.from}`;
      if (files.has(clave)) continue;
      files.set(clave, { fuente: 'arnes', ruta: s.from, modo: s.modo, kind: 'synthetic-source' });
      desde.set(clave, s.clave);
    }
    // de la ruta en su repo a la clave de la copia (una skill renombrada sale en otra)
    const porOrigen = new Map([...files].filter(([, a]) => a.kind !== 'synthetic-source').map(([clave, a]) => [`${a.fuente}/${a.ruta}`, clave]));
    for (const clave of desde.keys()) porOrigen.set(clave, clave);
    const content = (clave) => {
      if (desde.has(clave)) return copia.get(desde.get(clave)).datos;
      return copia.has(clave) ? copia.get(clave).datos : null;
    };
    return { pkg: P, files, pending: f.pendientes, content, keyOf: (fuente, ruta) => porOrigen.get(`${fuente}/${ruta}`) || null };
  });

  const raw = (source, ruta) => {
    const e = trees[source].get(ruta);
    return e && e.tipo === 'blob' ? read(source, [e.obj])(e.obj) : null;
  };
  const asText = (buf) => (buf && !detector.esBinario(buf) ? buf.toString('utf8') : null);

  /** Lo que se mira de un archivo: `[{ pkg, kind, pending?, text }]` (`pending` = la ruta del pendiente del que sale la
   *  pieza, para no mezclar las secciones de un mismo archivo; `text` null = no se mira: una traducción que se regenera, o un
   *  binario). El destino de un sintético se mira con lo que sale ahí —el contenido de su `from`—, nunca con el suyo. */
  function ofFile(source, ruta) {
    const clave = `${source}/${ruta}`;
    const out = [];
    for (const p of packages) {
      const k = p.keyOf(source, ruta);
      const a = k ? p.files.get(k) : null;
      if (a) out.push({ pkg: p.pkg, kind: a.kind, text: a.kind === 'translation' ? null : asText(p.content(k)) });
      for (const pend of p.pending) {
        const hash = pend.ruta.indexOf('#');
        if (hash < 0) {
          if (!coincide(pend.ruta, clave) || !trees[source].has(ruta)) continue;
          out.push({ pkg: p.pkg, kind: CODEX_TOML.test(clave) ? 'translation' : 'pending', pending: pend.ruta, text: CODEX_TOML.test(clave) ? null : asText(raw(source, ruta)) });
          continue;
        }
        if (pend.ruta.slice(0, hash) !== clave) continue;
        const frag = pend.ruta.slice(hash + 1);
        const text = asText(raw(source, ruta));
        if (text === null) continue;
        let piece;
        if (ruta === MANIFIESTO_CODEX) piece = frag;
        else if (ruta === CATALOGO) piece = onlySections(text, new Set([frag]));
        else if (LINEA_BASE.test(ruta)) {
          const prefix = frag.replace(/\*$/, '');
          const node = miembro(analizarJson(text), 'cases');
          piece = node && node.valor.tipo === 'objeto'
            ? node.valor.hijos.filter((h) => String(h.clave).startsWith(prefix)).map((h) => text.slice(h.ini, h.fin)).join('\n') : '';
        } else continue;
        out.push({ pkg: p.pkg, kind: 'pending', pending: pend.ruta, text: piece });
      }
    }
    return out;
  }

  /** Lee de un saque el contenido de muchos archivos (en vez de pedirle `ofFile` a cada uno). */
  function preload(pairs) {
    for (const source of FUENTES) {
      const objs = pairs.filter(([s]) => s === source).map(([, r]) => trees[source].get(r)).filter((e) => e && e.tipo === 'blob').map((e) => e.obj);
      if (objs.length) read(source, objs);
    }
  }

  return { packages, ofFile, preload };
}

/**
 * Los nombres en castellano de la copia: el freno los cuenta con su propio extractor. Se carga acá adentro
 * porque spanish-names.js usa este archivo. Si no se puede contar, el --json lo dice y el termómetro da rojo: la copia
 * igual sale (contar no es armarla).
 */
function contarCastellano(entradas, raiz = RAIZ_PROPIA) {
  try {
    return require('./spanish-names.js').countCopy(entradas, raiz);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

function main() {
  const ctx = {};
  let args = {};
  const alSalir = () => limpiar();
  process.on('exit', alSalir);
  // Lo que se escape de todo (incluso del manejo de un error) es un 2: node saldría con 1, que acá es «encontré algo».
  process.on('uncaughtException', (e) => {
    limpiar();
    process.stderr.write(`⛔ exportador: error no previsto: ${(e && e.stack) || e}\n`);
    process.exit(2);
  });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(s, () => {
      limpiar();
      process.stderr.write(`⛔ exportador: interrumpido (${s}); no quedó nada escrito\n`);
      process.exit(2);
    });
  }
  let codigo;
  try {
    args = parsear(process.argv.slice(2));
    const cfg = rutasDeConfig(args);
    if (args.explicar) {
      process.exitCode = explicar(args, cfg);
      return;
    }
    // el exportador no arma la copia. Pedírsela sale 2 diciéndolo, sin escribir nada.
    throw new NoPudo(NO_ARMA);
  } catch (e) {
    // Cualquier error —previsto o no— es un 2: el 1 significa «encontré algo» y un 0 sería una mentira.
    codigo = 2;
    limpiar();
    const motivo = e instanceof NoPudo ? e.message : (e && e.stack) || String(e);
    if (args.json) process.stdout.write(`${JSON.stringify({ resultado: 2, motivo }, null, 2)}\n`);
    process.stderr.write(`⛔ exportador: ${motivo}\n`);
  }
  limpiar();
  // exitCode y no exit(): con la salida estándar en un pipe, exit() corta lo que todavía no se escribió (un --json
  // grande llegaba truncado a 8 o 64 KB). Sin nada pendiente, node sale solo con este código.
  process.exitCode = codigo;
}

module.exports = {
  EXCLUIDOS_SIEMPRE, TRANSFORMACIONES, intersectan, nombraFija, analizarJson, dejarHijos, quitarSecciones,
  // «¿esta exclusión fija cubre la ruta?» con su `salvo`. Todo el que decide qué se publica la usa (el freno de
  // nombres, el comparador de copias, el control de lo publicable): con `coincide(x.glob)` a secas, las rutas del
  // `salvo` se leerían como privadas y el freno de nombres no las miraría.
  cubreFija,
  enSalvo,
  // la clasificación y lo que la rodea, para el freno de nombres nuevos (new-names.js) y sus pruebas
  FUENTES, PAQUETES_PRIVADOS, CODEX_TOML, NoPudo, git, salidaGit, leerObjetos, listarArbol, coincide,
  validarLista, validarTabla, cargarDenegados, prepararFuentes, primerNivel, filterPackage, transformar, whatShips,
  publicPackages, nombresPegados, reemplazar, parPuedeEstar, compilan, unseenProducts, productsOf, unseenValues, termHasPair, termsWithoutPair,
  // los nombres viejos del mapa de renombres (su prueba fuerza el mapa roto)
  nombresViejos, mencionesViejas,
  // el termómetro de nombres en castellano (su prueba fuerza el camino de error)
  contarCastellano,
  // las formas con que una guía nombra un archivo del arnés instalado (internal-history.js las
  // reconoce igual que la marca de las rutas que no viajan)
  installPrefixes,
  // el paquete por su nombre nuevo en una lista blanca de antes del renombre (new-names.js)
  paquetesConNombresNuevos,
  // el lector del nombre público (lo reusa la sincronización) y la lista de controles
  readPublicRepo, readPublicNameExceptions, COPY_CONTROLS,
  // los textos públicos (public-copy-messages.test.js los aplica a los archivos de verdad)
  applyPublicTexts,
  // la identidad fija del commit de la copia — la sincronización (mirror.js) firma sus commits con la misma
  COMMIT_IDENTITY: AUTOR,
  // la pregunta «¿este commit es del repo unido?» (una fuente física, o dos)
  isUnifiedCommit, PRIVATE_FOLDERS_NOTE, ignorePrivateFolders,
  // el nombre de cada parte del pre-commit del repo unido, para
  // que la foto de export-compare.js no anote como excluida una parte que split-hooks publica
  HOOK_PARTS,
  // la partición del pre-commit, para que su prueba fuerce los dos caminos de error
  splitHooks,
  // la versión numerada — el nombre del archivo, la forma del número y la función que arma sus bytes
  VERSION_FILE, VERSION_SHAPE, versionFileBytes,
  // ruta → blob de los árboles internos, con la regla de la lista de transformados (la usa verify)
  internalBlobs,
  // un comando del arnés por cualquiera de los dos nombres de su lugar
  candidatosDeComando, comandosColgados,
  // el control de las rutas que no viajan, para probarlo directo
  pathsNotInCopy,
};

// El arranque va DESPUÉS de los exports: el termómetro de la copia (`spanish-names.js`) se carga a mitad de `main()`
// y pide `coincide` a este mismo módulo; con el arranque arriba, los exports todavía estarían vacíos y el termómetro
// saldría «exporter.coincide is not a function» (export-real.test.sh, T20).
if (require.main === module) {
  // las opciones y los paquetes con su nombre viejo siguen andando hasta el retiro
  require('../lib/legacy-names.js').aliasArgv(MAPA_WHERE, { exitCode: 2, prefix: '⛔ exportador: ' });
  main();
}
