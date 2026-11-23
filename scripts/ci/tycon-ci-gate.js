#!/usr/bin/env node
/**
 * tycon-ci-gate.js — los controles del arnés que SÍ pueden correr del lado del servidor.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────
 * Los controles LOCALES (pre-commit y hooks de sesión) se saltean con una bandera de git. Un control que sólo
 * corre local hace que toda la protección del arnés sea **condicional a la máquina**:
 *
 *   · una persona sin el arnés instalado (alguien nuevo, otra máquina) commitea sin ningún control;
 *   · un merge o una edición hechos desde la web de Azure DevOps no pasan por ningún hook;
 *   · sin `core.hooksPath` global, los `.githooks/` del repo no corren;
 *   · la bandera que saltea hooks está frenada por el guard, pero **sólo si el guard está puesto**.
 *
 * El freno local sigue siendo el que atrapa temprano y con buen mensaje. Éste es la red de abajo:
 * lo que igual se verifica cuando el commit ya llegó al servidor.
 *
 * ── QUÉ CHEQUEA, Y POR QUÉ SÓLO ESTO ────────────────────────────────────────────────────────────
 * Únicamente lo que se puede decidir **con el repo y nada más**. Un control que necesita el estado
 * de la sesión (`~/.claude/...`), la base de engram o un servidor local NO puede correr acá, y
 * fingir que sí sería peor que no tenerlo.
 *
 *   1. **Frontmatter de stories legible** — cuando el frontmatter no parsea, las tools no dan
 *      error: saltean la story EN SILENCIO.
 *   2. **Evidencia de cierre** — una story que pasa a `review`/`done` en este diff tiene que traer
 *      su evidencia EN EL REPO (`.advisors/dod-runtime/<id>-*.md`, sin contar la matriz por AC, el
 *      self-audit ni el plan manual). Es la mitad del gate local que no depende de la
 *      sesión. Si el código vive en otro repo, la evidencia igual nace acá (`guides/ci-gate.md`). Se busca en git (en el
 *      índice con `--staged`) y de lo que dice sólo se lee si declara FAIL. Lo que eso agrega avisa hasta
 *      STRICT_EVIDENCE_FROM y frena desde ese día; también la carpeta de corrida que, por la fecha en que entró en git,
 *      pide registro de autoría.
 *   3. **Constancia de revisores** — una story que pasa a `done` tiene que tener una corrida del
 *      pipeline en el repo (`.advisors/pipeline-runs/<id>-…`). Es el ADVISORS-GATE del pre-commit,
 *      en su mitad verificable desde el servidor (la otra mitad vive en el `gates.log` local).
 *
 *   6. **Examen del revisor que cambia** — un cambio a `agents/<revisor>.md` trae el resultado del examen de ese revisor
 *      sobre ese archivo exacto, con puntaje igual o mayor que la línea de base (`controls-bench/reviewer-change-check.js`).
 *
 * Todos corren sin modelo, sin red y sin estado de sesión, pero no verifican lo mismo. Cada chequeo dice su nivel en la
 * salida y en `--json` (`verificacion`):
 *
 *   · LOS QUE VERIFICA EL SERVIDOR él mismo con el repo: el frontmatter legible (1), el índice de memoria (5) y el
 *     examen del revisor que cambia (6, recalcula el puntaje).
 *   · LOS QUE SÓLO MIRAN QUE EXISTA un archivo con el nombre esperado: la evidencia de cierre (2) y la constancia de
 *     revisores (3). Una evidencia que dice «hola» los pasa.
 *   · Los que leen un registro con forma válida de que algo corrió («ejecución registrada»): el registro de autoría (4),
 *     el de aprobaciones (4b) y el veredicto de la evidencia («no declara FAIL»). Que tenga forma válida no prueba que lo
 *     escribió el pipeline.
 *   · «No medido»: un chequeo que esta vez no se hizo (el examen sin su control junto a este guion, el índice local o
 *     que no se pudo comparar, la regla que no cargó, el chequeo que una exención perdona). Nunca va como verificado.
 *
 * El servidor no re-ejecuta nada: no compila, no corre pruebas, no levanta la app. Las exenciones se listan con su
 * razón, que se exige (`exencion-sin-razon`: avisa hasta EXEMPT_REASON_FROM y frena desde ese día), pero no se firman
 * acá: el portón no sabe quién las autorizó.
 *
 * ── ADOPCIÓN ────────────────────────────────────────────────────────────────────────────────────
 * Opt-in por repo: meter un paso nuevo en un pipeline de cliente
 * es decisión del dev, no de un script. El snippet de ADO está en `guides/ci-gate.md`. Dónde no está lo dice cada noche
 * el inventario de adopción (`scripts/nightly/gate-adoption/gate-adoption.js`).
 *
 * Uso:  node tycon-ci-gate.js [--repo <dir>] [--base <ref>] [--staged] [--json] [--selftest]
 *       `--staged` mira lo que está por commitearse (para el `.githooks/pre-commit` del repo) en
 *       vez del diff contra una rama; mismo criterio, mismo mensaje, diez segundos antes.
 * Exit: 0 al día · 1 hay stories que no deberían haber llegado al servidor
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

function git(repo, args, opts) {
  return execFileSync('git', ['-C', repo, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, maxBuffer: 32 * 1024 * 1024, ...(opts || {}) });
}

// 🔴 El criterio de "esto es una story" se IMPORTA del lint local, no se reescribe: un detector propio tomaría por
// story rota un reporte de medición que declara `story:` en el CUERPO, sin frontmatter.
// Dos detectores del mismo concepto son el drift de mañana.
const detector = require(path.join(__dirname, '..', 'lib', 'lint-story-frontmatter.js'));
const { readEnv, envNames } = require(path.join(__dirname, '..', 'lib', 'legacy-names.js'));
const { aliasLegacyOptions } = require(path.join(__dirname, 'legacy-options.js'));
const WHERE = 'scripts/ci/tycon-ci-gate.js';

// Las dos llaves que avisan (TYCON_REVIEW_A_DONE y TYCON_ROSTER_NAMES) vuelven a frenar con el mismo valor: `block`
// (como TYCON_ATDD_COMMIT_GATE=block). El valor viejo, una palabra en castellano, sigue valiendo
// hasta el retiro: el par va declarado acá como los de las opciones de esta carpeta (`<nombre>=<viejo>:<nuevo>`), para
// que el mapa de renombres y el guion digan lo mismo (lo cruza `spanish-names.js --check-map`), y lo pasa al nuevo el
// mismo traductor, que además anota el uso. El nombre del par es el de la primera de las dos llaves; vale para las dos.
const BLOCK = 'block';
const PAR_DE_LA_LLAVE = 'TYCON_REVIEW_A_DONE';
/** ¿El valor de una llave dice «frená»? */
function llaveFrena(valor) {
  if (valor === undefined || valor === null) return false;
  // (el primer argumento va sin comillas simples: `--check-map` lee la declaración del par con una expresión que no las cruza)
  return aliasLegacyOptions([`--${PAR_DE_LA_LLAVE}`, String(valor)], 'TYCON_REVIEW_A_DONE=freno:block', WHERE)[1] === BLOCK;
}

/** Frontmatter de un texto, o null si no cierra. */
function frontmatter(txt) {
  if (!txt.startsWith('---')) return null;
  const fin = txt.indexOf('\n---', 3);
  return fin === -1 ? null : txt.slice(3, fin);
}

/** ¿Este texto DECLARA ser una story? (identidad declarada, criterio del lint local) */
function declaraSerStory(txt, rel) {
  const zona = detector.frontmatterZone(String(txt).slice(0, 8192));
  if (zona === null) return false;                                   // sin `---`: no es una story
  if (detector.NOT_A_STORY_NAME.test(path.basename(rel))) return false;  // plantillas y ejemplos
  return detector.DECLARES_STORY.test(zona);
}

/** Escalar del frontmatter — MISMO regex que usan las tools del arnés (si esto lee, ellas leen). */
function escalar(fm, clave) {
  const m = String(fm).match(new RegExp(`^${clave}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm'));
  return m ? m[1].trim() : null;
}

const LISTOS = new Set(['review', 'done']);

// Los cuatro niveles de un chequeo (ver la cabecera). Van literales en `--json`.
const NIVELES = Object.freeze({
  ARCHIVO: 'archivo-presente',
  REGISTRO: 'ejecucion-registrada',
  SERVIDOR: 'verificado-por-el-servidor',
  NO_MEDIDO: 'no-medido',
});
const NIVEL_EN_PALABRAS = {
  'archivo-presente': 'archivo presente',
  'ejecucion-registrada': 'ejecución registrada',
  'verificado-por-el-servidor': 'verificado por el servidor',
  'no-medido': 'no medido',
};

// Una exención sin su razón entra avisando: hasta esta fecha avisa y deja pasar; desde esta fecha frena. Son dos semanas
// desde que el portón empieza a pedirla, para que cada repo complete las razones de sus historias cerradas. Ninguna
// variable de ambiente la mueve: la fecha se compara con el `hoy` que recibe `revisar`.
const EXEMPT_REASON_FROM = '2026-12-03';
const EXENCIONES = ['dod_runtime_exempt', 'advisors_exempt'];

// Lo que el portón empieza a reclamar al mirar git y el veredicto entra avisando, con la misma regla: hasta esta fecha
// avisa; desde ella frena. Son la evidencia que declara FAIL o no se pudo leer, la que está en el disco y no en git, y la
// carpeta de corrida que por su fecha en git pide registro de autoría. Lo que ya frenaba sigue frenando desde el primer
// día. Ninguna variable de ambiente la mueve.
const STRICT_EVIDENCE_FROM = '2026-12-07';

/** La fecha UTC del día, `AAAA-MM-DD`. */
function hoyUtc() { return new Date().toISOString().slice(0, 10); }

/**
 * La razón de una exención (`<campo>_reason`), o null si falta, está vacía o es un nulo de YAML (`~`, `null`). `escalar`
 * es de una línea: con una razón en bloque (`|` o `>`) devolvería el indicador, que no es una razón. Acá se juntan las
 * líneas indentadas que siguen al indicador, o a la clave sin valor (una razón escrita en la línea de abajo).
 */
function razonDe(fm, campo) {
  const lineas = String(fm).split('\n');
  const clave = new RegExp(`^${campo}_reason\\s*:`);
  const i = lineas.findIndex((l) => clave.test(l));
  if (i === -1) return null;
  let valor = lineas[i].replace(clave, '').trim();
  // entre comillas, la razón es lo de adentro; sin comillas, un `#` después de un espacio empieza un comentario
  const entre = /^(["'])(.*)\1(\s+#.*)?$/.exec(valor);
  if (entre) return entre[2].trim() || null;
  valor = valor.replace(/(^|\s)#.*$/, '').trim();
  if (!valor && /^\s*#/.test(lineas[i].replace(clave, ''))) return null;
  if (!valor || /^[|>][+-]?\d*$/.test(valor)) {
    const bloque = [];
    for (let j = i + 1; j < lineas.length && (/^\s+\S/.test(lineas[j]) || !lineas[j].trim()); j++) {
      if (lineas[j].trim()) bloque.push(lineas[j].trim());
    }
    return bloque.length ? bloque.join(' ') : null;
  }
  return !/^(~|null|Null|NULL)$/.test(valor) ? valor : null;
}

/**
 * El nivel del examen de revisores: lo verifica el servidor si su control está junto a este guion y pudo comparar; si
 * no estaba, o no pudo comparar (`examen.error`), no se midió.
 */
function nivelDelExamen(controlPresente, examen) {
  return controlPresente && !(examen && examen.error) ? NIVELES.SERVIDOR : NIVELES.NO_MEDIDO;
}

/** El nivel de un chequeo que busca un archivo con la clave de la story: sin clave, o exento, no se buscó nada. */
function nivelDeBusqueda(exenta, clave) { return exenta || !clave ? NIVELES.NO_MEDIDO : NIVELES.ARCHIVO; }

// la razón la escribe quien abre el pedido: antes de imprimirla, que no pueda dar órdenes al registro (`##vso[…]`)
const textoDeAfuera = (t) => String(t).replace(/#{2,}/g, '#');

/**
 * El nivel del chequeo del índice de memoria, según lo que devolvió `revisarIndiceDeMemoria`: null si el diff no lo
 * toca (no se nombra), no medido si el índice es local o no se pudo comparar, y del servidor si se comparó.
 */
function nivelDelIndice(mem) {
  if (!mem) return null;
  if (mem.engram && mem.engram.estado === 'indice-local') return NIVELES.NO_MEDIDO;
  if ((mem.avisos || []).some((a) => a.regla === 'indice-de-memoria-no-comparable')) return NIVELES.NO_MEDIDO;
  return NIVELES.SERVIDOR;
}

// El árbol vacío de git. Con él se puede pedir un `diff --cached` en un repo que todavía no tiene
// ningún commit — ahí `HEAD` no existe y la forma corta falla.
const ARBOL_VACIO = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Archivos `.md` que el diff toca: contra `base` en el servidor, contra HEAD (o sea, el ÍNDICE:
 * lo que está por commitearse) en el pre-commit.
 */
function mdDelDiff(repo, base, staged) {
  let salida = '';
  if (staged) {
    try { salida = git(repo, ['diff', '--cached', '--name-only']); }
    catch (_e) {
      try { salida = git(repo, ['diff', '--cached', '--name-only', ARBOL_VACIO]); }
      catch (_e2) { return { error: 'no pude leer lo que está por commitearse (`git diff --cached`)' }; }
    }
    return { files: salida.split('\n').filter((f) => f.endsWith('.md')) };
  }
  try { salida = git(repo, ['diff', '--name-only', `${base}...HEAD`]); }
  catch (_e) {
    try { salida = git(repo, ['diff', '--name-only', base, 'HEAD']); } catch (_e2) { return { error: `no pude comparar contra \`${base}\`` }; }
  }
  return { files: salida.split('\n').filter((f) => f.endsWith('.md')) };
}

// `ref` vacío NO es un descuido: `git show :ruta` es la versión del ÍNDICE, que es exactamente
// "lo que está por commitearse". Es lo que hace que el mismo motor sirva de los dos lados.
function contenidoEn(repo, ref, rel) {
  try { return git(repo, ['show', `${ref}:${rel}`]); } catch (_e) { return null; }
}

// 🔴 No todo `<id>-*` es evidencia de cierre: la matriz por AC (`-runtime-matrix.md`) lista los ACs INCLUIDOS los que
// no tienen evidencia, y el self-audit y el plan de prueba manual los escribe el agente libremente. El freno local los
// excluye (`findDodEvidence` de on-pre-commit.js); si este portón no lo hiciera, una copia de SÓLO la
// matriz —o un ledger suelto— lo pondría verde sin una corrida real detrás. Mismo criterio que el
// local: un `.md` con el prefijo de la story que no sea ninguno de esos tres.
// 🔴 Es una COPIA deliberada de `lib/closing-evidence.js` del skill: este portón corre
// en un agente sin `~/.claude/`, así que no puede importarla. Las dos las compara
// `scripts/tests/closing-evidence-parity.test.js` en cada corrida — mismo mecanismo que cuida
// `validarRoster`. El medidor del tablero importa ESTA copia (mismo repo), así que son dos en total.
// El freno del commit suma por AC la UNIÓN de las tres fuentes que escribe la máquina (registro de
// pruebas de humo, gates E2E y firmas del dev; `coberturaDeLaUnion` en la canónica). Acá no se copia a propósito: este
// portón nunca miró criterio por criterio —pide que exista evidencia de cierre— y la validez de las dos primeras
// fuentes se confirma contra gates.log, que vive en la máquina y no en el agente. Lo que sí comparten las dos capas
// es esta lista, y con ella el registro (`-smoke-ledger.jsonl`) y el gate (`-e2e-gate-*.md`) ya cuentan como evidencia;
// el `-cierre.md`, si existe, también (es un `.md`).
const NO_ES_EVIDENCIA_DE_CIERRE = [/-self-audit(?:-iter\d+)?\.md$/, /-runtime-matrix\.md$/, /-manual-test-plan\.md$/];
// El ledger de smokes CUENTA: es el registro crudo de cada prueba
// que corrió, escrito por la máquina — más difícil de falsear que un informe. Motivo completo en
// la canónica del skill.
const ES_EVIDENCIA_ADEMAS = [/-smoke-ledger\.jsonl$/];
function esEvidenciaDeCierre(f) {
  const n = String(f || '');
  if (ES_EVIDENCIA_ADEMAS.some((re) => re.test(n))) return true;
  return n.endsWith('.md') && !NO_ES_EVIDENCIA_DE_CIERRE.some((re) => re.test(n));
}

// ¿La evidencia declara FAIL? Es una COPIA deliberada de `evidenciaDeclaraFail` de `lib/closing-evidence.js` del skill,
// por el mismo motivo que la de arriba: el portón corre sin las skills. La compara
// `scripts/tests/closing-evidence-parity.test.js`. Es lo único que el portón lee de lo que dice la evidencia: una que
// dice «hola» no declara FAIL.
function evidenciaDeclaraFail(content) {
  if (!content) return false;
  if (/(^|\n)[ \t]*(?:[-*][ \t]*)?(?:\*\*)?verdict(?:[ \t]+global)?(?:\*\*)?[ \t]*[:=][ \t]*(?:\*\*)?[ \t]*FAIL\b/i.test(content)) return true;
  if (/##[ \t]*verdict[ \t]+global[ \t]*(?:\r?\n)+[ \t]*(?:\*\*)?FAIL\b/i.test(content)) return true;
  return false;
}

/**
 * Lo que hay en git: el árbol que va a escribir el commit con `--staged`, `HEAD` sin él. `{ lista, submodulos }` o
 * `{ error }`: un git que falla no es «no hay». Con `--staged` se lista el árbol de `write-tree` y no `ls-files`: una
 * ruta anotada con `git add -N` está en el índice sin contenido y el commit no la lleva. `submodulos`: los del primer
 * nivel, donde también busca el disco; git del repo no lista lo que tienen adentro.
 */
function archivosEnGit(repo, staged) {
  try {
    const arbol = staged ? git(repo, ['write-tree']).trim() : 'HEAD';
    const lista = [];
    const submodulos = [];
    for (const e of git(repo, ['ls-tree', '-r', '-z', arbol]).split('\0')) {
      const m = /^\d+ (\w+) [0-9a-f]+\t(.+)$/s.exec(e);
      if (!m) continue;
      if (m[1] === 'blob') lista.push(m[2]);
      else if (m[1] === 'commit' && !m[2].includes('/')) submodulos.push(m[2]);
    }
    return { lista, submodulos };
  } catch (_e) {
    return { error: staged ? 'git no listó lo que está por commitearse' : 'git no listó lo que trae el commit' };
  }
}

/** ¿Algún submódulo del primer nivel trae en el disco lo de la clave? Ahí el portón no puede decir «no está en git». */
function enSubmodulo(repo, sub, prefijo, enGit) {
  return !!(enGit && enGit.submodulos) && enGit.submodulos.some((s) => {
    try {
      return fs.readdirSync(path.join(repo, s, '.advisors', sub)).some((f) => f.startsWith(prefijo) && (sub !== 'dod-runtime' || esEvidenciaDeCierre(f)));
    } catch (_e) { return false; }
  });
}

// `.advisors/<sub>/<nombre>[/<archivo>]`, en la raíz o un nivel más abajo (monorepos), como la búsqueda en el disco.
const EN_ADVISORS = /^(?:([^/]+)\/)?\.advisors\/(dod-runtime|pipeline-runs)\/([^/]+)(?:\/(.+))?$/;
function enAdvisors(rel) {
  const m = EN_ADVISORS.exec(rel);
  if (!m || (m[1] && (m[1].startsWith('.') || m[1] === 'node_modules'))) return null;
  return { sub: m[2], nombre: m[3], adentro: m[4] || null, carpeta: `${m[1] ? `${m[1]}/` : ''}.advisors/${m[2]}/${m[3]}` };
}

/** La evidencia de cierre de la clave que está en git: `[{ rel, nombre }]`. */
function evidenciaEnGit(lista, prefijo) {
  return lista.map((rel) => ({ rel, e: enAdvisors(rel) }))
    .filter(({ e }) => e && e.sub === 'dod-runtime' && !e.adentro && e.nombre.startsWith(prefijo) && esEvidenciaDeCierre(e.nombre))
    .map(({ rel, e }) => ({ rel, nombre: e.nombre }));
}

/** Las carpetas de corrida de la clave que tienen algún archivo en git: `[{ rel, nombre }]`. Git no guarda carpetas. */
function carpetasEnGit(lista, prefijo) {
  const clave = prefijo.slice(0, -1);
  const vistas = new Map();
  for (const rel of lista) {
    const e = enAdvisors(rel);
    if (!e || e.sub !== 'pipeline-runs' || !e.adentro) continue;
    if (e.nombre !== clave && !e.nombre.startsWith(prefijo)) continue;
    vistas.set(e.carpeta, { rel: e.carpeta, nombre: e.nombre });
  }
  return [...vistas.values()];
}

/** ¿El registro de humos tiene al menos una línea JSON con `exit` igual a 0? (`smoke-run.sh` lo escribe en cada línea) */
function registroConSalidaCero(texto) {
  return String(texto).split('\n').some((l) => {
    try { const j = JSON.parse(l); return !!j && typeof j === 'object' && j.exit === 0; } catch (_e) { return false; }
  });
}

/**
 * El veredicto de la evidencia de cierre en git: pasa si algún archivo no declara FAIL (un `.md`) o tiene una salida 0
 * (el registro de humos). Un archivo que git no devuelve, o que no es texto, no deja pasar: `no-leido` si ningún otro
 * pasa. `{ estado: 'pasa' | 'falla' | 'no-leido', ilegibles }`.
 */
function veredictoDeEvidencia(repo, ref, archivos) {
  let pasa = false;
  const ilegibles = [];
  for (const { rel, nombre } of archivos) {
    const txt = contenidoEn(repo, ref, rel);
    if (txt === null) { ilegibles.push(`${rel} (git no lo devolvió)`); continue; }
    if (txt.includes('\u0000')) { ilegibles.push(`${rel} (no es texto)`); continue; }
    if (ES_EVIDENCIA_ADEMAS.some((re) => re.test(nombre)) ? registroConSalidaCero(txt) : !evidenciaDeclaraFail(txt)) pasa = true;
  }
  return { estado: pasa ? 'pasa' : (ilegibles.length ? 'no-leido' : 'falla'), ilegibles };
}

/**
 * Cuándo entró una carpeta de corrida en la historia de `ref`: `{ nueva: true }` si no está ahí, `{ fecha: 'AAAA-MM-DD' }`
 * o `{ error }`. La fecha es la del primer commit que la agregó en `ref`: la de un commit del pedido no cuenta. En un clon
 * recortado git no falla, contesta la fecha del borde del recorte, así que se pregunta antes. `correr`: el ejecutor de git.
 */
function fechaDeCarpeta(repo, ref, rel, correr = git) {
  if (!ref) return { nueva: true };
  try {
    if (!correr(repo, ['--literal-pathspecs', 'ls-tree', '-d', '--name-only', ref, '--', rel]).trim()) return { nueva: true };
    const recortado = correr(repo, ['rev-parse', '--is-shallow-repository']).trim();
    if (recortado !== 'false') {
      return { error: recortado === 'true' ? 'el clon está recortado y git daría la fecha del borde del recorte' : 'git no dijo si el clon está recortado' };
    }
    const fechas = correr(repo, ['--literal-pathspecs', 'log', ref, '--diff-filter=A', '--format=%cs', '--', rel])
      .split('\n').map((l) => l.trim()).filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(l));
    return fechas.length ? { fecha: fechas[fechas.length - 1] } : { error: 'git no dijo cuándo entró' };
  } catch (_e) {
    return { error: 'git no contestó' };
  }
}

const conGuiones = (aaaammdd) => `${aaaammdd.slice(0, 4)}-${aaaammdd.slice(4, 6)}-${aaaammdd.slice(6, 8)}`;

/**
 * El registro de autoría mirado por git: alcanza con un `review-roster.json` válido en git, en alguna carpeta de la clave.
 * Sin él, se exige por cada carpeta nueva en el pedido, con el nombre que traiga; por la que ya estaba y entró desde el
 * corte; por la que trae en el nombre una fecha desde el corte; y por la que no se pudo fechar. La que trae en el nombre
 * una fecha anterior al corte y entró después no se exige: es una contradicción que se avisa.
 */
function autoriaPorGit({ repo, refNuevo, refViejo, carpetas, fechar = fechaDeCarpeta }) {
  const valida = carpetas.some(({ rel }) => {
    const txt = contenidoEn(repo, refNuevo, `${rel}/review-roster.json`);
    if (txt === null) return false;
    try { return validarRoster(JSON.parse(txt), null).ok; } catch (_e) { return false; }
  });
  const exige = [];
  const contradictorias = [];
  if (valida) return { exige, contradictorias };
  for (const c of carpetas) {
    const m = c.nombre.match(/-(\d{8})(?:-?\d*)?$/);
    const sello = m ? m[1] : null;
    if (sello && sello >= CUTOFF_ROSTER) { exige.push({ ...c, motivo: `su nombre trae el ${conGuiones(sello)}, desde el corte` }); continue; }
    const f = fechar(repo, refViejo, c.rel);
    if (f.nueva) exige.push({ ...c, motivo: 'es nueva en este pedido' });
    else if (f.error) exige.push({ ...c, motivo: `no pude fechar la carpeta: ${f.error}` });
    else if (f.fecha.replace(/-/g, '') >= CUTOFF_ROSTER) {
      if (sello) contradictorias.push({ ...c, fechaNombre: conGuiones(sello), fechaGit: f.fecha });
      else exige.push({ ...c, motivo: `entró en git el ${f.fecha}, desde el corte` });
    }
  }
  return { exige, contradictorias };
}

// La CLAVE de la evidencia de cierre: con un número repetido en el repo, `<id>-*` es la
// evidencia de cualquiera de las stories que lo comparten — el portón le daría a una la de la otra. La calcula
// lib/evidence-key.js del skill tycon-pipeline, que se encuentra igual que el descubridor de stories del lint.
// Sin la biblioteca, el id de siempre y un aviso visible: el portón no deja de correr por esto.
let evidenceKeyLib = null;
let evidenceKeyFalta = null;
try {
  const skills = require(path.join(__dirname, '..', 'lib', 'skills-dir.js')).resolveSkillsDirs().skills;
  evidenceKeyLib = require(path.join(skills, 'tycon-pipeline', 'scripts', 'lib', 'evidence-key.js'));
} catch (e) { evidenceKeyFalta = e.message; }

/** El prefijo de la evidencia de cierre: `<clave>-`, o null si la clave no se puede decidir (no hay evidencia). */
// La regla es la de `evidencePrefix` (lib/evidence-key.js), la misma que usa el freno del frontmatter: sin ruta, el número; con ruta y sin archivo, nada —no se sabe si el número se repite—; sin clave, nada. Lo
// propio del portón es sólo el aviso, y el respaldo si la biblioteca no está.
function prefijoDeEvidencia(storyId, storyPath) {
  if (!storyPath) return `${storyId}-`;
  if (!evidenceKeyLib || typeof evidenceKeyLib.evidencePrefix !== 'function') {
    // Sin la biblioteca, lo único que se puede sostener sin ella: una story que no está en disco no da nada por bueno.
    if (!fs.existsSync(storyPath)) {
      process.stderr.write(`⚠️  tycon-ci-gate: no encuentro la story ${storyPath} — sin ella no sé si el número ${storyId} se repite, así que no doy evidencia ni constancia por buenas.\n`);
      return null;
    }
    const falta = evidenceKeyLib ? 'está, pero es una versión vieja sin evidencePrefix: la copia de las skills quedó atrasada' : `no la encontré: ${evidenceKeyFalta}`;
    process.stderr.write(`⚠️  tycon-ci-gate: lib/evidence-key.js ${falta} — la evidencia de ${storyId} se busca por el número solo: en un número repetido puede ser de otra story.\n`);
    return `${storyId}-`;
  }
  const { prefix, error } = evidenceKeyLib.evidencePrefix(storyPath, storyId);
  // «No pude calcular la clave» no es «no hay evidencia»: el motivo se dice, para que nadie busque un archivo que falta.
  if (!prefix) process.stderr.write(`⚠️  tycon-ci-gate: ${error} — sin clave no doy evidencia ni constancia por buenas.\n`);
  return prefix;
}

/** ¿Hay evidencia de este tipo para esta story, en cualquier parte del repo? `storyPath`: ver prefijoDeEvidencia. */
// `prefijoYa` (opcional): el prefijo ya calculado por quien llama — `undefined` = calcularlo acá. Así `revisar` lo
// calcula UNA vez por story (recorrer el repo y avisar dos veces es costo y ruido).
function hayEvidencia(repo, sub, storyId, storyPath, prefijoYa) {
  const raiz = path.join(repo, '.advisors', sub);
  const dirs = [raiz];
  // Los monorepos guardan la evidencia por sub-proyecto: se mira un nivel más.
  try {
    for (const e of fs.readdirSync(repo, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      dirs.push(path.join(repo, e.name, '.advisors', sub));
    }
  } catch (_e) { /* raíz ilegible */ }
  // Las carpetas de corrida (`pipeline-runs`) van por la misma clave: con un número repetido,
  // `<id>-*` le daría a una story la constancia de revisores de otra.
  const prefijo = prefijoYa !== undefined ? prefijoYa : prefijoDeEvidencia(storyId, storyPath);
  if (!prefijo) return false;
  for (const d of dirs) {
    let entradas = [];
    try { entradas = fs.readdirSync(d); } catch (_e) { continue; }
    if (entradas.some((f) => f.startsWith(prefijo) && (sub !== 'dod-runtime' || esEvidenciaDeCierre(f)))) return true;
  }
  return false;
}

// ── Regla 4: registro de autoría (revisor ≠ autor) ─────────────────────────────────────────────
// El AI-Native SDLC Playbook pide un revisor con IA en el servidor. Acá la revisión ya ocurre
// ANTES del PR y con más contexto (la sesión implementa, ~28 advisors subagentes revisan) — lo que
// faltaba era que el rastro lo DIJERA, para poder exigirlo en vez de confiar. Lo escribe el hook
// `on-advisor-run.js` derivándolo del ledger de spawns reales: `review-roster.json` en el run dir.
//
// 🔴 Corte por fecha, MECÁNICO y sin config: el nombre del run dir trae su timestamp. Un run
// anterior al estreno de la pieza no puede tener roster — su ausencia AVISA. De ahí en adelante,
// la ausencia FRENA. Y un roster presente pero mentiroso o incoherente frena SIEMPRE, sin corte:
// dato malo es peor que dato ausente.
const CUTOFF_ROSTER = process.env.TYCON_ROSTER_CUTOFF || '20260831';

// Por la clave de la story, igual que la constancia: `storyPath` es la ruta de la story en el repo.
// Sin clave calculable no hay carpeta que dar por suya (prefijoDeEvidencia ya dijo el motivo).
function runDirsDeStory(repo, storyId, storyPath) {
  const pref = prefijoDeEvidencia(storyId, storyPath);
  if (!pref) return [];
  const clave = pref.slice(0, -1);
  // La lista es la de lib/approvals.js, la misma con que el cierre del pipeline busca las corridas. Sin la biblioteca,
  // la misma búsqueda acá, para que la regla 4 siga mirando el roster.
  let carpetas;
  if (approvalsLib && typeof approvalsLib.carpetasDeCorrida === 'function') {
    carpetas = approvalsLib.carpetasDeCorrida(repo, clave);
  } else {
    const bases = [path.join(repo, '.advisors', 'pipeline-runs')];
    try {
      for (const e of fs.readdirSync(repo, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        bases.push(path.join(repo, e.name, '.advisors', 'pipeline-runs'));
      }
    } catch (_e) { /* raíz ilegible */ }
    carpetas = [];
    for (const b of bases) {
      let entradas = [];
      try { entradas = fs.readdirSync(b); } catch (_e) { continue; }
      for (const n of entradas) if (n === clave || n.startsWith(`${clave}-`)) carpetas.push({ dir: path.join(b, n), nombre: n });
    }
  }
  // El sello de fecha del run dir tiene DOS formas en los repos reales: `1.1-AAAAMMDDhhmmss`
  // y `4.2-AAAAMMDD-hhmm` (fecha y hora separadas). Leer sólo la primera dejaría a la segunda
  // "sin fecha" — y sin fecha esto frenaría corridas viejas que no pueden tener el registro.
  return carpetas.map(({ dir, nombre }) => {
    const m = nombre.match(/-(\d{8})(?:-?\d*)?$/);
    return { dir, nombre, stamp: m ? m[1] : null };
  });
}

/** Advisors nombrados en los hallazgos del run — el cruce que SÍ se puede hacer server-side. */
function advisoresEnFindings(runDir) {
  const nombres = new Set();
  let raw;
  // Que FALTE es normal (una corrida puede no tener hallazgos) y se calla. Que esté ROTO apaga el
  // cruce entero sin que nadie se entere, y eso no es «está todo bien»: se dice por stderr.
  // Sigue sin frenar: un archivo ilegible no es una incoherencia probada.
  try { raw = fs.readFileSync(path.join(runDir, 'findings.json'), 'utf8'); } catch (_e) { return null; }
  // 🔴 Este aviso sale por el registro PÚBLICO de la corrida del portón, así que dice lo justo:
  // el nombre de la corrida, nunca la ruta absoluta del checkout (lleva el nombre del repo y del
  // cliente), y NUNCA el mensaje crudo del parser — en V8 ese mensaje arrastra el token que rompió
  // el parseo, o sea un pedazo real del archivo. Mismo criterio que `cierre-recortado` T10 le exige
  // a la constancia del cierre. El que necesita el detalle lo tiene en su máquina.
  const cual = `${path.basename(runDir)}/findings.json`;
  let data;
  try { data = JSON.parse(raw); } catch (_e) {
    console.error(`⚠️  ${cual} no se puede leer (JSON inválido): el cruce entre quién firmó los `
      + 'hallazgos y quién figura en el registro de revisores NO corrió.');
    return null;
  }
  // 🔴 El tercer camino: JSON válido pero con una forma que no
  // es ni una lista ni `{findings: [...]}`. Caería al `[]` mudo, o sea que el cruce se apagaría sin
  // que nadie se enterara — el mismo agujero que el JSON roto. Los tres casos son los mismos que en el freno local.
  let lista;
  if (Array.isArray(data)) lista = data;
  else if (Array.isArray(data && data.findings)) lista = data.findings;
  else {
    console.error(`⚠️  ${cual} no es una lista de hallazgos: el cruce entre quién firmó los `
      + 'hallazgos y quién figura en el registro de revisores NO corrió. No es «está todo bien».');
    return null;
  }
  const conTramo = new Map();
  for (const f of lista) {
    const a = f && (f.advisor || f.agent || f.source);
    if (typeof a !== 'string' || !a) continue;
    const clave = `${a}|${(f && f.tramo) || ''}`;
    if (!conTramo.has(clave)) conTramo.set(clave, f && f.tramo ? { advisor: a, tramo: f.tramo } : a);
    nombres.add(a);
  }
  return [...conTramo.values()];
}

function revisarAutoria(repo, storyId, storyPath) {
  const dirs = runDirsDeStory(repo, storyId, storyPath);
  if (!dirs.length) return []; // la regla 3 ya cubre "no hay ningún run dir"
  const hallazgos = [];
  // Alcanza con que UN run dir de la story traiga el registro válido (el re-loop puede dejar
  // varios; el bueno es el que tiene el roster).
  let algunoValido = false;
  let algunoPostCutoff = false;
  const problemasVistos = [];
  for (const { dir, nombre, stamp } of dirs) {
    // Sin fecha legible NO se reclama la ausencia: un repo con otra convención de nombres no puede
    // pagar por una regla que no existía cuando corrió. Lo que SÍ frena siempre es el dato
    // presente y malo, y eso no depende del sello.
    if (stamp && stamp >= CUTOFF_ROSTER) algunoPostCutoff = true;
    let roster = null;
    let ilegible = null;
    try {
      roster = JSON.parse(fs.readFileSync(path.join(dir, 'review-roster.json'), 'utf8'));
    } catch (e) {
      if (e && e.code !== 'ENOENT') ilegible = String(e.message).slice(0, 120);
    }
    if (ilegible) {
      // Presente y roto: frena siempre, haya corte o no.
      hallazgos.push({ regla: 'registro-de-autoria-invalido',
        mensaje: `\`${nombre}/review-roster.json\` no se puede leer (${ilegible}). Un registro ilegible no es un registro: regeneralo corriendo los revisores; la exención de los revisores (\`advisors_exempt: true\` con su razón) la decide la persona, con su firma sobre la historia.` });
      continue;
    }
    if (!roster) continue;
    const v = validarRoster(roster, advisoresEnFindings(dir));
    if (v.ok) { algunoValido = true; continue; }
    for (const p of v.problemas) problemasVistos.push({ ...p, nombre });
  }
  if (algunoValido) return hallazgos;
  // Ningún roster válido: o hay problemas concretos (frenan siempre), o falta el archivo.
  if (problemasVistos.length) {
    for (const p of problemasVistos) {
      hallazgos.push({ regla: p.regla, mensaje: `\`${p.nombre}/review-roster.json\`: ${p.detalle}`, ...(p.validado ? { validado: true } : {}) });
    }
    return hallazgos;
  }
  if (!algunoPostCutoff) return hallazgos; // run viejo: la ausencia no se le puede reclamar
  hallazgos.push({ regla: 'sin-registro-de-autoria',
    mensaje: `pasa a \`done\` y ningún \`.advisors/pipeline-runs/${prefijoDeEvidencia(storyId, storyPath)}*/\` trae \`review-roster.json\` (quién implementó y quiénes revisaron). Lo escribe solo el hook al cerrar la ronda de revisores; si esta story se cerró sin pipeline, la exención (\`advisors_exempt: true\` + su razón) la decide la persona, con su firma sobre la historia.` });
  return hallazgos;
}

// ── Regla 4b: el registro de aprobaciones ─────────────────────────────────────────
// Cada aprobación de una corrida queda en `approvals.jsonl`: manual (una persona con nombre) o automática (un agente o
// una regla). Lo escribe marker.js; la regla del tipo vive en lib/approvals.js del skill, que el portón carga igual que
// evidence-key (está en este mismo checkout). Frena SIEMPRE una aprobación de agente anotada como manual (dato malo).
// La ausencia frena sólo si la corrida DECLARA que la hizo un arnés que anota aprobaciones: su `review-roster.json`
// trae `registro_aprobaciones` (lo pone el hook al cerrar la ronda de revisores). Toda corrida así pasó por la
// aprobación del plan, así que se exige esa línea, no sólo el archivo. Sin la marca —un dev con el arnés de antes,
// cuyo portón en CI ya es el nuevo— la falta avisa y no frena: no hizo nada mal. Sin corte por fecha a propósito: la
// fecha no dice qué arnés corrió en la máquina.
let approvalsLib = null;
let approvalsFalta = null;
try {
  const skills = require(path.join(__dirname, '..', 'lib', 'skills-dir.js')).resolveSkillsDirs().skills;
  approvalsLib = require(path.join(skills, 'tycon-pipeline', 'scripts', 'lib', 'approvals.js'));
} catch (e) { approvalsFalta = e.message; }

// `ref`: la historia en la que se busca el rastro de una corrida anterior al control (la base del pedido).
function revisarAprobaciones(repo, storyId, storyPath, ref = 'origin/main') {
  const hallazgos = [];
  const avisos = [];
  const resumen = { manual: 0, automatica: 0, sinNombrar: 0 };
  const dirs = runDirsDeStory(repo, storyId, storyPath);
  if (!dirs.length) return { hallazgos, avisos, resumen };
  // Sin la biblioteca el portón no puede juzgar el registro: falla cerrado, con el motivo.
  if (!approvalsLib) {
    hallazgos.push({ regla: 'registro-de-aprobaciones-sin-revisar',
      mensaje: `no pude cargar lib/approvals.js del skill tycon-pipeline (${approvalsFalta}): sin ella no sé si alguna aprobación de un agente figura como de una persona. No es «está bien»: es «no lo pude revisar».` });
    return { hallazgos, avisos, resumen };
  }
  for (const { dir, nombre } of dirs) {
    const reg = approvalsLib.leer(dir);
    let roster = null;
    try { roster = JSON.parse(fs.readFileSync(path.join(dir, 'review-roster.json'), 'utf8')); } catch (_e) { /* la regla 4 juzga el roster */ }
    const llegoARevisores = fs.existsSync(path.join(dir, 'review-roster.json'));
    // La regla es la de lib/approvals.js, la misma con que frena el cierre del pipeline; acá se arma el mensaje.
    const anterior = typeof approvalsLib.anteriorAlControl === 'function' && approvalsLib.anteriorAlControl(dir, nombre, ref);
    const problemas = approvalsLib.problemasDelRegistro({ registro: reg, roster, anterior });
    const hay = (regla) => problemas.find((p) => p.regla === regla);
    const invalido = hay('registro-de-aprobaciones-invalido');
    if (invalido) {
      hallazgos.push({ regla: invalido.regla,
        mensaje: `\`${nombre}/${approvalsLib.FILE}\` ${invalido.detalle}. Un registro ilegible no es un registro.` });
    }
    if (!reg.existe) {
      if (hay('sin-registro-de-aprobaciones')) {
        hallazgos.push({ regla: 'sin-registro-de-aprobaciones',
          mensaje: `\`${nombre}/\` llegó a los revisores y no trae \`${approvalsLib.FILE}\` (qué se aprobó, cuándo y si fue una persona o un agente). Lo escribe marker.js al aprobar el plan. Si está en disco y no en el commit, el \`.gitignore\` lo traga: falta \`!**/.advisors/pipeline-runs/*/approvals.jsonl\` (el arranque del pipeline la agrega). Si la story se cerró sin pipeline, la exención (\`advisors_exempt: true\` + su razón) la decide la persona, con su firma sobre la historia.` });
      } else if (llegoARevisores) {
        avisos.push({ regla: 'sin-registro-de-aprobaciones',
          mensaje: `\`${nombre}/\` no trae \`${approvalsLib.FILE}\`, y la ejecución no tenía por qué dejarlo acá: su registro de revisores no declara que anote aprobaciones (un arnés anterior al registro de aprobaciones), o arrancó antes de que el registro llegara al repo de la story: no se sabe quién aprobó el plan. Avisa y no frena.` });
      }
      continue;
    }
    for (const l of reg.lineas) {
      for (const p of approvalsLib.validar(l)) {
        hallazgos.push({ regla: p.regla, mensaje: `\`${nombre}/${approvalsLib.FILE}\`: ${p.detalle}. La aprobación de un agente nunca cuenta como la de una persona: va \`automatica\`, con la delegación nombrada.` });
      }
    }
    const r = approvalsLib.resumir(reg.lineas);
    resumen.manual += r.manual; resumen.automatica += r.automatica; resumen.sinNombrar += r.sinNombrar;
    if (hay('sin-aprobacion-del-plan')) {
      hallazgos.push({ regla: 'sin-aprobacion-del-plan',
        mensaje: `\`${nombre}/${approvalsLib.FILE}\` existe pero no trae la aprobación del plan, y la ejecución llegó a los revisores: el plan se aprobó (marker.js no deja pasar sin eso) y no quedó anotado quién lo aprobó.` });
    }
  }
  return { hallazgos, avisos, resumen };
}

/**
 * Validación del roster. Es una COPIA deliberada de `lib/review-roster.js → validate` del skill:
 * el portón corre en un agente de CI que sólo hace checkout de este repo y del repo del producto,
 * sin `~/.claude/`. La paridad entre las dos definiciones la cuida
 * `scripts/tests/roster-validate-parity.test.js`, que corre LAS DOS sobre los mismos casos y
 * compara veredicto y reglas — no la buena memoria de quien las edite.
 */
// Por PREFIJO, idéntico a `lib/review-roster.js`: las fuentes del propio pipeline se reconocen por su prefijo, y sin
// alguna de ellas un run real daría `roster-incoherente`.
const FUENTES_SINTETICAS = [
  /^mech-check$/, /^pipeline$/,
  /^adversarial-verify(\s|:|\(|-|$)/,   // `-fable`, `-opus`: variantes del mismo paso
  /^pase adversarial(\s|:|\(|-|$)/,     // el mismo paso 5b nombrado en castellano
  /^orquestador(\s|\(|$)/,
  /^runtime-matrix(\s|\(|$)/,
  /^e2e-runtime(\s|:|\(|-|$)/,          // el gate de E2E del step 7c: tampoco es un spawn
  /^ensayo runtime(\s|\(|$)/,
];

// 🔴 El nombre del revisor se escribe en DOS lados con dos criterios: el roster lo proyecta una máquina desde el
// ledger de spawns —`tycon-silent-failure-hunter`, pelado—, y el `advisor` de `findings.json` lo tipea el
// orquestador, que puede agregarle la vuelta o el modelo para que un humano lo lea:
// `tycon-silent-failure-hunter (iter 3)`. Comparados letra por letra, el segundo "no figura entre los revisores" y
// el portón frenaría un PR sano.
//
// ── POR QUÉ EL RECORTE SIGUE ACÁ ──────────────────────────────────────────
// `write-findings` valida el firmante contra los revisores de esa corrida y guarda el id pelado, con la anotación en
// campos propios (`iter`, `model`, `nota`). O sea que los hallazgos NUEVOS no traen paréntesis.
//
// Pero el portón no lee sólo hallazgos nuevos: hay hallazgos YA COMMITEADOS con la anotación pegada al nombre, y una
// máquina que no actualizó el skill los sigue escribiendo así. El recorte es la tolerancia del
// LECTOR mientras ese histórico exista; retirarlo volvería a marcar como ausentes a revisores
// que sí corrieron (lo fija `scripts/tests/roster-validate-parity.test.js`).
//
// Se retira cuando no queden corridas vivas con el formato viejo. Lo que NO se hace es sumar una
// regex por cada adorno nuevo.
//
// El paréntesis final es una anotación, nunca parte del id de un agente (son kebab-case, sin
// paréntesis). Se recorta sólo al final, así que no puede fusionar dos agentes distintos.
function nombreCanonico(nombre) {
  return String(nombre || '').replace(/\s*\([^()]*\)\s*$/, '').trim();
}

function validarRoster(roster, advisores) {
  const problemas = [];
  const add = (regla, detalle) => problemas.push({ regla, detalle });
  if (!roster || typeof roster !== 'object') {
    add('registro-de-autoria-invalido', 'no es un objeto JSON');
    return { ok: false, problemas };
  }
  if (roster.version !== 1) add('registro-de-autoria-invalido', `version ${JSON.stringify(roster.version)} desconocida`);
  const impl = roster.implementer;
  if (!impl || typeof impl !== 'object' || !impl.kind) add('registro-de-autoria-invalido', 'falta el bloque implementer');
  const revs = Array.isArray(roster.reviewers) ? roster.reviewers : null;
  if (!revs) {
    add('registro-de-autoria-invalido', 'reviewers no es una lista');
  } else if (!revs.length) {
    add('sin-revisores', 'no lista ningún revisor');
  } else {
    for (const r of revs) {
      if (!r || typeof r.agent !== 'string' || !r.agent) { add('registro-de-autoria-invalido', 'hay un revisor sin nombre'); continue; }
      if (r.kind === 'sesion-principal' || (impl && impl.session_id && r.session_id === impl.session_id && r.kind !== 'subagente')) {
        add('revisor-es-el-autor', `"${r.agent}" figura como revisor pero es la sesión que implementó`);
      }
    }
  }
  if (advisores && revs) {
    // ── Tramo contra tramo ────────────────────────────────────────────────────────
    // El roster cubre la RONDA DEL PASO 5 (arranca en el último `step5-start`) y `findings.json`
    // cubre toda la corrida. Un hallazgo del paso 1 —la validación de la story, antes de
    // implementar— caería siempre como "revisor ausente". Y la ventana del roster NO se puede ensanchar, porque ahí adentro
    // está `general-purpose`, que implementa. Por eso el roster lista aparte los agentes de los
    // pasos previos y cada hallazgo dice de qué tramo viene.
    const nombresDe = (lista) => {
      const out = new Set();
      for (const r of (Array.isArray(lista) ? lista : [])) {
        if (!r || !r.agent) continue;
        out.add(r.agent); out.add(nombreCanonico(r.agent));
      }
      return out;
    };
    const enRevision = nombresDe(revs);
    const enPrevios = nombresDe(roster.agentes_previos);
    for (const item of advisores) {
      // Texto pelado (la forma vieja, que sigue valiendo) o `{advisor, tramo}` (lo que escribe
      // `write-findings`). Sin tramo declarado se compara contra los dos.
      const a = (item && typeof item === 'object') ? item.advisor : item;
      const tramo = (item && typeof item === 'object') ? item.tramo : null;
      if (!a || typeof a !== 'string') continue;
      // Las fuentes que escribe el propio pipeline (`mech-check`, el pase adversarial) NUNCA son
      // un spawn y nunca van a estar en el roster: exigirles asiento frenaría casi toda story real
      // con hallazgos, y sin salida — agregarlas a mano dispara `roster-fabricado` en el
      // freno local.
      const canon = nombreCanonico(a);
      if (FUENTES_SINTETICAS.some((re) => re.test(a) || re.test(canon))) continue;
      const listas = tramo === 'previo' ? [enPrevios]
        : tramo === 'revision' ? [enRevision]
          : [enRevision, enPrevios];
      if (!listas.some((set) => set.has(a) || set.has(canon))) {
        // 🔴 `validado` = este hallazgo traía su `tramo`, y `tramo` lo escribe `write-findings`
        // SÓLO cuando pudo leer el registro y ubicar al firmante — o sea, cuando la validación de
        // verdad ocurrió al escribirlo. Un hallazgo así que igual no cuadra es una
        // incoherencia REAL y puede frenar. Uno sin `tramo` es del formato viejo, nadie lo validó,
        // y sigue avisando: frenar por el formato repetiría el frenón de un pull request sano.
        // Se enciende solo a medida que las corridas viejas dejan de cerrarse — sin día de corte y
        // sin que nadie tenga que acordarse de cerrar una ventana de medición.
        const p = { regla: 'roster-incoherente', detalle: tramo === 'previo'
          ? `"${a}" reportó hallazgos del tramo previo al paso de revisores y no figura entre los agentes de ese tramo`
          : `"${a}" reportó hallazgos pero no figura entre los revisores` };
        if (tramo) p.validado = true;
        problemas.push(p);
      }
    }
  }
  return { ok: problemas.length === 0, problemas };
}

// ¿Este diff toca la memoria de engram? Una sola pregunta a git, y si la respuesta es que no, el
// chequeo 5 no lee NADA: cero costo y cero ruido en el 99% de los pull requests.
//
// 🔴 `--no-renames`: esta lista DECIDE por ruta si el chequeo corre. Sin la opción git empareja
// un borrado con un alta y lista sólo la ruta nueva: el índice (o un chunk) movido a otra carpeta no aparecería como
// tocado, y el chequeo no correría. Con la opción, un archivo movido son dos líneas —la vieja y la nueva— y la vieja se
// ve. (`mdDelDiff`, arriba, no la lleva a propósito: lista los `.md` que hay que LEER, y el de la ruta vieja ya no está.)
function tocaEngram(repo, base, staged) {
  let salida = '';
  if (staged) {
    try { salida = git(repo, ['diff', '--cached', '--name-only', '--no-renames']); }
    catch (_e) {
      try { salida = git(repo, ['diff', '--cached', '--name-only', '--no-renames', ARBOL_VACIO]); }
      catch (_e2) { return { error: 'no pude leer lo que está por commitearse (`git diff --cached`)' }; }
    }
  } else {
    try { salida = git(repo, ['diff', '--name-only', '--no-renames', `${base}...HEAD`]); }
    catch (_e) {
      try { salida = git(repo, ['diff', '--name-only', '--no-renames', base, 'HEAD']); } catch (_e2) { return { error: `no pude comparar contra \`${base}\`` }; }
    }
  }
  return { toca: salida.split('\n').some((f) => f === '.engram/manifest.json' || f.startsWith('.engram/chunks/')) };
}

// ── Chequeo 5: el índice de memoria declara sus archivos ────────────────
// El criterio es el MISMO que usan el freno del commit y el aviso diario: `scripts/lib/
// manifest-engram.js`. Este control existe porque es lo único que ve los commits hechos FUERA del
// asistente —la web de Azure, otra máquina, un hook salteado—, que son justo los que el freno del
// commit no puede tocar. Misma asimetría que allá: lo que este pull request ROMPE frena; lo que ya
// venía roto, y lo que no se pudo comparar, avisan.
function revisarIndiceDeMemoria(repo, base, staged) {
  const t = tocaEngram(repo, base, staged);
  if (t.error) return { avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-no-comparable', mensaje: `no pude comparar el índice de memoria: ${t.error}` }] };
  if (!t.toca) return null;                                    // el diff no lo toca: no se lee nada

  let criterio;
  try { criterio = require(path.join(__dirname, '..', 'lib', 'manifest-engram.js')); }
  catch (e) { return { avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-no-comparable', mensaje: `no pude comparar el índice de memoria: falta el criterio (${e.message})` }] }; }

  // En «índice local» el índice no está en el árbol: no hay nada que comparar, y se dice.
  const modo = criterio.modoDelIndice ? criterio.modoDelIndice(repo) : { modo: null, problema: null };
  if (modo.problema) return { avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-no-comparable', mensaje: `no pude comparar el índice de memoria: ${modo.problema}` }] };
  if (modo.modo === 'local') return { engram: { estado: 'indice-local', motivo: 'índice local: no viaja por git' } };

  // 🔴 «Lo de antes» es la BASE DE MERGE, no la punta de `--base`.
  // `tocaEngram` y `mdDelDiff` ya usan `base...HEAD` (tres puntos = desde donde se separó la rama);
  // cruzar contra la punta de main sería otra noción de «antes» en el mismo control, y frenaría pull
  // requests que no rompieron nada: alcanza con que main repare el índice DESPUÉS del fork para
  // que sus entradas nuevas aparezcan como «perdidas» en una rama que nunca las tuvo.
  let referencia = staged ? 'HEAD' : base;
  if (!staged) {
    // 🔴 Si la base de merge no se puede calcular (clon shallow, historias sin ancestro común) NO se
    // cae en silencio a la punta: eso reabriría el mismo bug. Se dice y no se frena.
    try { referencia = git(repo, ['merge-base', base, 'HEAD']).trim(); }
    catch (e) {
      const motivo = String((e && e.stderr) || (e && e.message) || e).trim().split('\n')[0];
      return { avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-no-comparable', mensaje: `no pude comparar el índice de memoria: sin base de merge entre \`${base}\` y HEAD (${motivo})` }] };
    }
    if (!referencia) return { avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-no-comparable', mensaje: `no pude comparar el índice de memoria: \`git merge-base ${base} HEAD\` no devolvió nada` }] };
  }
  const r = criterio.cruzar(repo, { arbol: staged ? '' : 'HEAD', contra: referencia });
  if (r.estado === 'no-medido') {
    return { engram: r, avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-no-comparable', mensaje: `no pude comparar el índice de memoria: ${r.motivo}` }] };
  }
  if (!r.contra.legible) {
    // Nunca se frena un pull request por lo que no se pudo comparar — ni se lo da por bueno.
    return { engram: r, avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-no-comparable', mensaje: `no pude comparar el índice de memoria contra \`${r.contra.ref}\`: ${r.contra.motivo}` }] };
  }
  const arreglo = 'node scripts/lib/manifest-engram.js repair --apply';
  if (r.huerfanosNuevos.length) {
    const detalle = [];
    if (r.perdidas.length) detalle.push(`entradas que \`${r.contra.ref}\` declara y este cambio ya no: ${r.perdidas.join(', ')}`);
    if (r.chunksSinEntrada.length) detalle.push(`archivos de memoria nuevos sin entrada: ${r.chunksSinEntrada.join(', ')}`);
    return {
      engram: r,
      hallazgos: [{
        archivo: '.engram/manifest.json',
        regla: 'indice-de-memoria-perdio-entradas',
        mensaje: `${detalle.join(' · ')}. Esa memoria queda en el repo y ninguna otra máquina la importa — y no da error. Reparación: \`${arreglo}\`.`,
      }],
    };
  }
  if (r.estado === 'deriva') {
    const detalle = [];
    if (r.huerfanosHeredados.length) detalle.push(`archivos sin entrada (de antes): ${r.huerfanosHeredados.join(', ')}`);
    if (r.fantasmas.length) detalle.push(`entradas cuyo archivo no está: ${r.fantasmas.join(', ')}`);
    if (r.duplicados.length) detalle.push(`entradas repetidas: ${r.duplicados.join(', ')}`);
    return { engram: r, avisos: [{ archivo: '.engram/manifest.json', regla: 'indice-de-memoria-en-deriva', mensaje: `${detalle.join(' · ')}. Este cambio no lo empeora. Reparación: \`${arreglo}\`.` }] };
  }
  return { engram: r };
}

// `hoy` (`AAAA-MM-DD`): contra él se comparan las fechas de corte escritas en el código. Por defecto, la fecha UTC del día.
function revisar({ repo, base, staged, hoy = hoyUtc() }) {
  const hallazgos = [];
  const avisos = [];
  const revisadas = [];
  const aprobaciones = [];
  const verificacion = [];
  const exenciones = [];
  const { files, error } = mdDelDiff(repo, base, staged);
  if (error) return { error, hallazgos, revisadas, verificacion, exenciones };

  // Qué es "lo nuevo" y qué es "lo de antes" depende de dónde corre el portón. En el servidor lo
  // nuevo ya es un commit (HEAD) y lo de antes es la rama destino del pull request. En el
  // pre-commit lo nuevo todavía está en el índice y lo de antes es el último commit. El criterio
  // —qué frena y qué no— es EL MISMO: lo único que cambia es contra qué se compara.
  const refNuevo = staged ? '' : 'HEAD';
  const refViejo = staged ? 'HEAD' : base;
  // Lo que hay en git, una vez por corrida y sólo si alguna historia lo pide. Sin `HEAD` (el primer commit) no hay
  // referencia vieja: toda carpeta es nueva.
  let enGit;
  const listaDeGit = () => (enGit !== undefined ? enGit : (enGit = archivosEnGit(repo, staged)));
  let hayCabeza;
  const refDeAntes = () => {
    if (!staged) return refViejo;
    if (hayCabeza === undefined) { try { git(repo, ['rev-parse', '--verify', '-q', 'HEAD']); hayCabeza = true; } catch (_e) { hayCabeza = false; } }
    return hayCabeza ? refViejo : null;
  };

  for (const rel of files) {
    const nuevo = contenidoEn(repo, refNuevo, rel);
    if (nuevo === null) continue;                       // borrado en este diff
    const fmNuevo = frontmatter(nuevo);
    // La identidad de una story es `story:`, en todo el arnés (`declaresStoryIdentity`). Leer también `storyId:` le
    // daría a una story controles acá y no en el pipeline.
    const idBruto = fmNuevo && escalar(fmNuevo, 'story');

    // (1) frontmatter que no cierra en un archivo que DECLARA ser una story: silencio, no error.
    if (fmNuevo === null && declaraSerStory(nuevo, rel)) {
      hallazgos.push({ archivo: rel, regla: 'frontmatter-roto',
        mensaje: 'declara `story:` y su frontmatter NO cierra con `---`. Las tools del arnés no dan error con esto: saltean la story en silencio, y desaparece del validator, del backfill y de los gates.' });
      continue;
    }
    if (!idBruto) {                                     // no es una story
      // …pero si se parece a una en review/done, se dice: que nadie crea que pasó por los controles. Sólo se mira si
      // la clave ESTÁ, nunca se toma su valor como número de story. Tres caminos al silencio, los tres cerrados:
      // pasar a review/done; renombrar `story:` a `storyId:` sin tocar el estado —la story
      // deja de estar bajo control y nadie se entera—; y un frontmatter roto, que no deja leer nada.
      const cabeza = fmNuevo !== null ? fmNuevo : (nuevo.startsWith('---') ? nuevo.split('\n').slice(0, 60).join('\n') : null);
      const est = cabeza ? String(escalar(cabeza, 'status') || '').toLowerCase() : '';
      if (cabeza && /^storyId:\s*\S/m.test(cabeza) && LISTOS.has(est)) {
        const v = contenidoEn(repo, refViejo, rel);
        const fv = v === null ? null : frontmatter(v);
        const estViejo = fv ? String(escalar(fv, 'status') || '').toLowerCase() : '';
        const eraStory = !!(fv && escalar(fv, 'story'));
        if (fmNuevo === null || eraStory || estViejo !== est) {
          const como = fmNuevo === null ? `está en \`${est}\`, su frontmatter NO cierra con \`---\``
            : eraStory ? `está en \`${est}\` y su \`story:\` pasó a llamarse \`storyId:\``
            : `pasa a \`${est}\``;
          avisos.push({ archivo: rel, regla: 'storyid-sin-story',
            mensaje: `${como} y declara \`storyId:\` y no \`story:\`: para el arnés no es una story, así que el portón no le revisó evidencia ni revisores. Si es una story, la clave es \`story:\`.` });
        }
      }
      continue;
    }
    const estadoNuevo = String(escalar(fmNuevo, 'status') || '').toLowerCase();
    if (!LISTOS.has(estadoNuevo)) continue;

    const viejo = contenidoEn(repo, refViejo, rel);
    const fmViejo = viejo === null ? null : frontmatter(viejo);
    const estadoViejo = fmViejo ? String(escalar(fmViejo, 'status') || '').toLowerCase() : '';
    if (estadoViejo === estadoNuevo) continue;          // ya estaba así: no es una transición

    revisadas.push({ archivo: rel, story: idBruto, de: estadoViejo || '(nueva)', a: estadoNuevo });

    // 🔴 `review → done` en el pre-commit AVISA, no frena: la decisión de avisar primero, medir, y recién
    // después frenar vive en el hook del skill y en esta copia, corrida por git en `--staged`. Si esta copia
    // frenara la misma transición diez segundos después del aviso, el aviso sería inerte y la medición
    // nunca se acumularía. Misma llave que el skill: TYCON_REVIEW_A_DONE=block. En el pull request
    // (sin `--staged`) frena.
    const soloAviso = staged && estadoViejo === 'review' && estadoNuevo === 'done'
      && !llaveFrena(process.env.TYCON_REVIEW_A_DONE);
    const destino = soloAviso ? avisos : hallazgos;

    // La clave de la story, UNA vez: la usan la evidencia de cierre y la constancia de revisores.
    // Perezosa: sólo se recorre el repo si alguna de las dos reglas la necesita.
    let prefStory;
    const prefijoDeLaStory = () => (prefStory !== undefined ? prefStory : (prefStory = prefijoDeEvidencia(idBruto, path.join(repo, rel))));
    // con el archivo: dos historias pueden declarar el mismo número
    const nivel = (chequeo, n, detalle) => verificacion.push({ story: idBruto, archivo: rel, chequeo, nivel: n, ...(detalle ? { detalle } : {}) });
    // Lo que entra con una fecha de corte: antes de la fecha avisa; desde ella va por `destino` (así `review → done` en el
    // pre-commit sigue avisando). `cuando` es la frase que lo dice en el mensaje.
    const porFecha = (fecha) => {
      const desde = hoy >= fecha;
      const canal = desde ? destino : avisos;
      const cuando = !desde ? `Avisa hasta el ${fecha} y frena desde ese día`
        : canal === hallazgos ? 'Frena'
          : `Desde el ${fecha} en el pedido frena; acá (\`review → done\` antes del commit) avisa`;
      return { canal, cuando, antes: !desde };
    };
    const estricto = (regla, mensaje) => {
      const { canal, cuando, antes } = porFecha(STRICT_EVIDENCE_FROM);
      canal.push({ archivo: rel, story: idBruto, regla, mensaje: `${mensaje} ${cuando}.`, ...(antes ? { porFecha: true } : {}) });
    };
    const noEstaEnGit = (que, falla) => (falla
      ? `no pude buscar ${que} en git (${falla}); en el disco está`
      : `${que} está en el disco y no en ${staged ? 'lo que se va a commitear' : 'el commit'}: el servidor no la va a ver. Puede faltar un \`git add\`, o el \`.gitignore\` la deja afuera (la guía del portón dice qué tiene que dejar pasar)`);

    // (1) su frontmatter se leyó: lo verificó el servidor
    nivel('frontmatter-legible', NIVELES.SERVIDOR);

    // Las exenciones, con su razón. Sin razón: avisa hasta EXEMPT_REASON_FROM y frena desde ese día (por `destino`, así
    // `review → done` en el pre-commit sigue avisando).
    for (const campo of EXENCIONES) {
      if (!new RegExp(`^${campo}:\\s*true\\b`, 'm').test(fmNuevo)) continue;
      const razon = razonDe(fmNuevo, campo);
      exenciones.push({ story: idBruto, archivo: rel, campo, razon });
      if (razon) continue;
      const { canal, cuando } = porFecha(EXEMPT_REASON_FROM);
      canal.push({ archivo: rel, story: idBruto, regla: 'exencion-sin-razon',
        mensaje: `declara \`${campo}: true\` sin \`${campo}_reason\`. La exención apaga un chequeo del portón: su razón va escrita en la story, que es lo único que el servidor puede mostrar (no sabe quién la autorizó). ${cuando}.` });
    }

    // (2) evidencia de cierre en el repo
    const exentaDod = /^dod_runtime_exempt:\s*true\b/m.test(fmNuevo);
    nivel('evidencia-de-cierre', exentaDod ? NIVELES.NO_MEDIDO : nivelDeBusqueda(false, prefijoDeLaStory()));
    // Primero git: la evidencia que se commitea (o ya está en el commit) es la que cuenta, esté o no en el disco. Sin ella
    // en git, el disco decide como siempre: si tampoco está ahí frena como hoy; si está, sale por la regla de fecha.
    const gitDod = !exentaDod && prefijoDeLaStory() ? listaDeGit() : null;
    const dodEnGit = gitDod && gitDod.lista ? evidenciaEnGit(gitDod.lista, prefijoDeLaStory()) : [];
    if (dodEnGit.length) {
      const v = veredictoDeEvidencia(repo, refNuevo, dodEnGit);
      if (v.estado === 'no-leido') nivel('veredicto-de-la-evidencia', NIVELES.NO_MEDIDO);
      else nivel('veredicto-de-la-evidencia', NIVELES.REGISTRO, v.estado === 'pasa' ? 'no declara FAIL' : 'declara FAIL');
      if (v.estado === 'falla') {
        estricto('evidencia-de-cierre-falla', `pasa a \`${estadoNuevo}\` y toda su evidencia de cierre declara FAIL (${dodEnGit.length} archivo(s)). El portón sólo lee eso: que una no declare FAIL no prueba que pasó. Hace falta una ejecución que no falle.`);
      } else if (v.estado === 'no-leido') {
        estricto('veredicto-no-leido', `pasa a \`${estadoNuevo}\` y no pude leer el veredicto de su evidencia de cierre: ${v.ilegibles.join(', ')}. No es «está bien»: es «no lo pude leer».`);
      }
    } else if (!exentaDod) {
      nivel('veredicto-de-la-evidencia', NIVELES.NO_MEDIDO);
    }
    const dodEnDisco = !exentaDod && !dodEnGit.length && hayEvidencia(repo, 'dod-runtime', idBruto, path.join(repo, rel), prefijoDeLaStory());
    if (dodEnDisco && enSubmodulo(repo, 'dod-runtime', prefijoDeLaStory(), gitDod)) {
      // en un submódulo: pasa como antes de leer git, y su veredicto queda «no medido» (arriba)
    } else if (dodEnDisco) {
      estricto('sin-evidencia-de-cierre', `pasa a \`${estadoNuevo}\` y ${noEstaEnGit(`su evidencia de cierre (\`.advisors/dod-runtime/${prefijoDeLaStory()}*\`)`, gitDod && gitDod.error)}.`);
    } else if (!exentaDod && !dodEnGit.length) {
      // Igual que la constancia de revisores (abajo): sin clave el portón no miró, y la salida no es declarar una
      // exención — que taparía un número repetido — sino arreglar lo que impide calcularla.
      const prefDod = prefijoDeLaStory();
      destino.push({ archivo: rel, story: idBruto, regla: 'sin-evidencia-de-cierre',
        mensaje: !prefDod
          ? `pasa a \`${estadoNuevo}\` y no pude calcular la clave de la story ${idBruto} (${rel}) para buscar su evidencia de cierre: sin clave no se da evidencia por buena (el motivo está en el aviso del portón). No es «no hay evidencia»: es «no la pude buscar» — no lo tapes con \`dod_runtime_exempt\`.`
          : `pasa a \`${estadoNuevo}\` y no hay \`.advisors/dod-runtime/${prefDod}*.md\` en el repo. Si de verdad no hay nada que verificar corriendo la app, eximirla lo decide la persona («autorizo dod_runtime_exempt» en su mensaje), con su razón en la story.` });
    }

    // (3) constancia de que los revisores auditaron la story, EN ESTE repo
    const exentaAdv = /^advisors_exempt:\s*true\b/m.test(fmNuevo);

    // (2b) el registro de aprobaciones: manual o automática, y un agente nunca como persona. Corre aun con
    // `advisors_exempt`: la exención perdona que FALTE el registro (una story cerrada sin pipeline), no un registro
    // presente y malo — un agente anotado como persona frena siempre.
    {
      const apr = revisarAprobaciones(repo, idBruto, path.join(repo, rel), staged ? 'origin/main' : base);
      const POR_FALTA = (approvalsLib && approvalsLib.POR_FALTA) || new Set(['sin-registro-de-aprobaciones', 'sin-aprobacion-del-plan']);
      for (const h of apr.hallazgos) if (!(exentaAdv && POR_FALTA.has(h.regla))) destino.push({ archivo: rel, story: idBruto, ...h });
      if (!exentaAdv) for (const a of apr.avisos) avisos.push({ archivo: rel, story: idBruto, ...a });
      aprobaciones.push({ story: idBruto, archivo: rel, ...apr.resumen });
      // Sin la lib, o sin ningún registro en sus carpetas de corrida, el registro no se leyó.
      const leido = !!approvalsLib && runDirsDeStory(repo, idBruto, path.join(repo, rel)).some(({ dir }) => approvalsLib.leer(dir).existe);
      nivel('registro-de-aprobaciones', leido ? NIVELES.REGISTRO : NIVELES.NO_MEDIDO);
    }
    if (estadoNuevo === 'done') nivel('constancia-de-revisores', exentaAdv ? NIVELES.NO_MEDIDO : nivelDeBusqueda(false, prefijoDeLaStory()));
    // la carpeta de corrida, con la misma regla: está en git si algún archivo suyo lo está
    const gitRuns = estadoNuevo === 'done' && !exentaAdv && prefijoDeLaStory() ? listaDeGit() : null;
    const carpetasGit = gitRuns && gitRuns.lista ? carpetasEnGit(gitRuns.lista, prefijoDeLaStory()) : [];
    const constanciaEnGit = carpetasGit.some(({ nombre }) => nombre.startsWith(prefijoDeLaStory()));
    const runsEnDisco = estadoNuevo === 'done' && !exentaAdv && !constanciaEnGit && hayEvidencia(repo, 'pipeline-runs', idBruto, path.join(repo, rel), prefijoDeLaStory());
    if (runsEnDisco && enSubmodulo(repo, 'pipeline-runs', prefijoDeLaStory(), gitRuns)) {
      // en un submódulo: pasa como antes de leer git
    } else if (runsEnDisco) {
      estricto('sin-constancia-de-revisores', `pasa a \`done\` y ${noEstaEnGit(`su carpeta de revisores (\`.advisors/pipeline-runs/${prefijoDeLaStory()}*/\`)`, gitRuns && gitRuns.error)}.`);
    } else if (estadoNuevo === 'done' && !exentaAdv && !constanciaEnGit) {
      const pref = prefijoDeLaStory();
      // Sin clave el portón NO miró (falla cerrado): el hallazgo lo dice, no sólo el aviso por stderr.
      // «No pude verificar» y «no hay constancia» piden cosas distintas al dev.
      destino.push({ archivo: rel, story: idBruto, regla: 'sin-constancia-de-revisores',
        mensaje: !pref
          ? `pasa a \`done\` y no pude calcular la clave de la story ${idBruto} (${rel}) para buscar su carpeta de revisores: sin clave no se da constancia por buena (el motivo está en el aviso del portón). No es «no hay constancia»: es «no la pude buscar».`
          : `pasa a \`done\` y no hay \`.advisors/pipeline-runs/${pref}*/\` en el repo${pref !== `${idBruto}-` ? ` (el número ${idBruto} se repite en el repo: la carpeta lleva la clave de esta story; las \`${idBruto}-*\` viejas no dicen de cuál son y no cuentan)` : ''}. La exención (\`advisors_exempt: true\` + su razón) la decide la persona, con su firma sobre la historia.` });
    }

    // (4) el que escribió el código no puede ser el que lo revisó — y tiene que estar ESCRITO
    //
    // 🔴 `roster-incoherente` AVISA, no frena. Las otras tres reglas
    // del registro —que exista, que se pueda leer, que el autor no figure como revisor— se ganaron
    // el lugar y siguen frenando. Ésta no: lo que falló fue ELLA, no lo que
    // vigila. Frenaría casi toda story real porque las fuentes que escribe el propio
    // pipeline (`mech-check`, `adversarial-verify:*`) no son spawns y nunca están en el roster, y
    // también frenaría un pull request con la vuelta o el modelo pegados al nombre del revisor.
    //
    // El motivo de bajarla y no borrarla: un control cuyas únicas fallas son propias, y que cuesta
    // mañanas, termina apagado ENTERO con un `advisors_exempt: true` — y ahí se pierden también
    // las tres que sí sirven. Como aviso sigue diciendo lo que ve y se puede contar.
    //
    // Vuelve a frenar con TYCON_ROSTER_NAMES=block, y `write-findings` la deja casi imposible de
    // fallar (el firmante de un hallazgo se ELIGE de los revisores que corrieron, no se tipea):
    // cuando eso esté, se revisa si vuelve a frenar o si directamente sobra.
    // ejecución registrada sólo si alguna carpeta de corrida trae su registro: sin él, el portón no leyó nada
    const conRegistro = () => runDirsDeStory(repo, idBruto, path.join(repo, rel)).some(({ dir }) => fs.existsSync(path.join(dir, 'review-roster.json')));
    if (estadoNuevo === 'done') nivel('registro-de-autoria', !exentaAdv && conRegistro() ? NIVELES.REGISTRO : NIVELES.NO_MEDIDO);
    if (estadoNuevo === 'done' && !exentaAdv) {
      // 🔴 El canal lo decide el PROPIO hallazgo, no la regla entera: uno que trae
      // su `tramo` fue validado al escribirse contra el registro de esa corrida, así que si igual
      // no cuadra es una incoherencia REAL y frena. Uno sin `tramo` es del formato viejo —nadie lo
      // validó— y sigue avisando. Vuelve a frenar sola a medida que las corridas viejas dejan de
      // cerrarse, sin día de corte y sin depender de que alguien cierre una ventana de medición.
      const nombresFrenan = llaveFrena(readEnv('TYCON_ROSTER_NAMES', { where: WHERE }));
      const autoria = revisarAutoria(repo, idBruto, path.join(repo, rel));
      for (const h of autoria) {
        const esAviso = h.regla === 'roster-incoherente' && !nombresFrenan && !h.validado;
        (esAviso ? avisos : destino).push({ archivo: rel, story: idBruto, ...h });
      }
      // Lo de arriba mira el disco y la fecha del nombre, y frena como siempre. Si no reclamó nada, se mira git: la fecha
      // en que la carpeta entró, que no elige quien la crea. Lo que encuentra sale por la regla de fecha. La incoherencia
      // del disco no es un reclamo: con ella sola, un registro que no está en git pasaría.
      if (!autoria.some((h) => h.regla !== 'roster-incoherente') && carpetasGit.length) {
        const a = autoriaPorGit({ repo, refNuevo, refViejo: refDeAntes(), carpetas: carpetasGit });
        for (const c of a.contradictorias) {
          avisos.push({ archivo: rel, story: idBruto, regla: 'carpeta-fecha-contradictoria',
            mensaje: `\`${c.rel}/\` trae en el nombre el ${c.fechaNombre}, antes del corte del registro de autoría, y entró en git el ${c.fechaGit}, después. No se le exige el registro (una ejecución vieja que entró por squash o por una migración); si no lo es, revisalo. Avisa y no frena.` });
        }
        if (a.exige.length) {
          estricto('sin-registro-de-autoria', `pasa a \`done\` y ninguna carpeta de ejecución trae en git un \`review-roster.json\` válido, y lo piden: ${a.exige.map((c) => `\`${c.rel}/\` (${c.motivo})`).join(', ')}. La fecha sale de git, no del nombre: el nombre lo elige quien crea la carpeta. Lo escribe el hook al cerrar la ronda de revisores; si esta story se cerró sin pipeline, declaralo con \`advisors_exempt: true\` + su razón.`);
        }
      }
    }
  }
  // (5) el índice de memoria de engram — a nivel REPO, no por archivo `.md`
  const mem = revisarIndiceDeMemoria(repo, base, staged);
  if (mem) {
    for (const h of (mem.hallazgos || [])) hallazgos.push(h);
    for (const a of (mem.avisos || [])) avisos.push(a);
  }
  const nivelMem = nivelDelIndice(mem);
  if (nivelMem) verificacion.push({ story: null, chequeo: 'indice-de-memoria', nivel: nivelMem });

  // (6) el examen del revisor que cambia — a nivel REPO, sólo si el control está junto a este guion
  const examenPath = path.join(__dirname, '..', 'controls-bench', 'reviewer-change-check.js');
  const examen = fs.existsSync(examenPath) ? require(examenPath).checkReviewerChange({ repo, base, staged }) : null;
  verificacion.push({ story: null, chequeo: 'examen-de-revisores', nivel: nivelDelExamen(!!examen, examen) });
  if (examen) {
    if (examen.error) hallazgos.push({ archivo: 'agents/', regla: 'reviewer-exam-not-comparable', mensaje: `no pude comparar los cambios de revisores: ${examen.error}. Comando: \`node scripts/controls-bench/reviewer-change-check.js check\`` });
    for (const h of examen.hallazgos) hallazgos.push({ archivo: h.archivo, regla: h.regla, mensaje: `${h.mensaje} Comando: \`${h.comando}\`` });
    for (const a of examen.avisos) avisos.push(a);
  }

  return { hallazgos, avisos, revisadas, aprobaciones, verificacion, exenciones, archivos: files.length, ...(mem && mem.engram ? { engram: mem.engram } : {}) };
}

// ── selftest ────────────────────────────────────────────────────────────────────────────────────
function selftest() {
  // La autoprueba deja la evidencia en el disco sin commitearla: con un `hoy` fijo, anterior a las fechas de corte, no se
  // pone roja sola el día que llega una. Lo que pasa desde cada fecha lo prueban sus suites.
  const HOY_FIJO = '2026-11-01';
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-'));
  const sh = (...a) => execFileSync('git', ['-C', tmp, ...a], { stdio: 'ignore' });
  fs.mkdirSync(path.join(tmp, 'specs', 'stories'), { recursive: true });
  const story = (estado, extra = '') => `---\nstory: "1.1"\nepic: "1"\nstatus: ${estado}\n${extra}---\n# Story 1.1\n`;
  fs.writeFileSync(path.join(tmp, 'specs', 'stories', '1-1.md'), story('in-progress'));
  sh('init', '-q', '-b', 'main', '.'); sh('add', '-A');
  sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base');
  const base = git(tmp, ['rev-parse', 'HEAD']).trim();

  const conStory = (txt) => { fs.writeFileSync(path.join(tmp, 'specs', 'stories', '1-1.md'), txt); sh('add', '-A'); sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'x'); };

  conStory(story('done'));
  const sinNada = revisar({ hoy: HOY_FIJO, repo: tmp, base });

  // 🔴 Lo que NO es evidencia de cierre aunque lleve el prefijo: la matriz por AC,
  // el self-audit y el plan manual. Con estos archivos el portón daría VERDE — una
  // copia parcial de la evidencia de otro repo lo satisfaría.
  fs.mkdirSync(path.join(tmp, '.advisors', 'dod-runtime'), { recursive: true });
  for (const f of ['1.1-runtime-matrix.md', '1.1-self-audit-iter1.md', '1.1-manual-test-plan.md']) {
    fs.writeFileSync(path.join(tmp, '.advisors', 'dod-runtime', f), 'no es evidencia');
  }
  const soloMatriz = revisar({ hoy: HOY_FIJO, repo: tmp, base });
  // 🔴 …pero el ledger de smokes SÍ: es el registro crudo de cada
  // prueba que corrió, escrito por la máquina. La definición única rige en las cuatro capas a la vez.
  fs.writeFileSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-smoke-ledger.jsonl'), '{"story":"1.1","acs":[1],"exit":0}\n');
  const conLedger = revisar({ hoy: HOY_FIJO, repo: tmp, base });
  fs.rmSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-smoke-ledger.jsonl'));
  // …y el gate E2E del proyecto (commiteado a mano) sí lo es.
  fs.writeFileSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-e2e-gate-20260905T120000Z.md'), 'verdict=PASS');
  const conGate = revisar({ hoy: HOY_FIJO, repo: tmp, base });
  fs.rmSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-e2e-gate-20260905T120000Z.md'));
  // …y el smoke driven de UI (`<id>-ui-smoke-<ts>.md`) y el del macro (`<id>-<ts>.md`) también.
  fs.writeFileSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-ui-smoke-20260905T120000Z.md'), 'AC→assertion');
  const conUiSmoke = revisar({ hoy: HOY_FIJO, repo: tmp, base });
  fs.rmSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-ui-smoke-20260905T120000Z.md'));

  fs.writeFileSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-20260825.md'), 'evidencia');
  const soloDod = revisar({ hoy: HOY_FIJO, repo: tmp, base });

  fs.mkdirSync(path.join(tmp, '.advisors', 'pipeline-runs', '1.1-20260825'), { recursive: true });
  const completo = revisar({ hoy: HOY_FIJO, repo: tmp, base });

  conStory(story('done', 'dod_runtime_exempt: true\ndod_runtime_exempt_reason: autoprueba\nadvisors_exempt: true\nadvisors_exempt_reason: autoprueba\n'));
  fs.rmSync(path.join(tmp, '.advisors'), { recursive: true, force: true });
  const exenta = revisar({ hoy: HOY_FIJO, repo: tmp, base });

  conStory('---\nstory: "1.1"\nstatus: done\n# falta el cierre\n');
  const roto = revisar({ hoy: HOY_FIJO, repo: tmp, base });

  conStory(story('in-progress'));
  const sinTransicion = revisar({ hoy: HOY_FIJO, repo: tmp, base });

  // 🔴 Un reporte de medición SIN frontmatter que menciona `story:` en el cuerpo no es una story y no
  // se puede tratar como una story rota. Se caza con el detector del lint local.
  fs.mkdirSync(path.join(tmp, 'mediciones'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'mediciones', 'resultado.md'),
    '# Qué reglas implementa el proceso\n\nmide: cadena\nstory: 4.37\nmaterial: filas.json\n');
  sh('add', '-A'); sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'medicion');
  const medicion = revisar({ hoy: HOY_FIJO, repo: tmp, base });

  // ── Regla 4: registro de autoría ────────────────────────────────────────────────────────────
  conStory(story('done', 'dod_runtime_exempt: true\ndod_runtime_exempt_reason: autoprueba\n'));
  const runPost = path.join(tmp, '.advisors', 'pipeline-runs', '1.1-20260901120000');
  fs.mkdirSync(runPost, { recursive: true });
  // (a) run POSTERIOR al corte y sin roster → frena
  const postSinRoster = revisar({ hoy: HOY_FIJO, repo: tmp, base });
  const rosterOk = {
    version: 1, story: '1.1', implementer: { kind: 'sesion-principal', session_id: 's1' },
    reviewers: [{ agent: 'tycon-plugin-security-basics', kind: 'subagente', model: 'opus' }], iterations: 1,
  };
  // (b) con roster válido → limpio
  fs.writeFileSync(path.join(runPost, 'review-roster.json'), JSON.stringify(rosterOk));
  const postConRoster = revisar({ hoy: HOY_FIJO, repo: tmp, base });
  // (c) el que implementó figura como revisor → frena (aunque el run sea viejo)
  fs.writeFileSync(path.join(runPost, 'review-roster.json'), JSON.stringify({
    ...rosterOk, reviewers: [{ agent: 'yo-mismo', kind: 'sesion-principal' }],
  }));
  const autoRevision = revisar({ hoy: HOY_FIJO, repo: tmp, base });
  // (d) findings nombra un advisor que el roster no lista → incoherente
  fs.writeFileSync(path.join(runPost, 'review-roster.json'), JSON.stringify(rosterOk));
  fs.writeFileSync(path.join(runPost, 'findings.json'), JSON.stringify([{ advisor: 'fantasma', rule_id: 'X-1' }]));
  const incoherente = revisar({ hoy: HOY_FIJO, repo: tmp, base });
  // (d1) la misma entrada con la llave puesta: la regla vuelve a frenar (el kill-switch se prueba,
  // no se confía — un interruptor que nadie ejerce es un interruptor que no se sabe si anda).
  const incoherenteFreno = (() => {
    // Se guardan y se restauran los DOS nombres ([nuevo, viejo] del mapa): mientras dura la prueba sólo queda el nuevo
    // (un viejo distinto no la estorba), y al salir cada uno vuelve a lo que era — el viejo nunca queda pisando al nuevo.
    const nombres = envNames('TYCON_ROSTER_NAMES');
    const antes = nombres.map((k) => process.env[k]);
    for (const k of nombres) delete process.env[k];
    process.env.TYCON_ROSTER_NAMES = 'block';
    try { return revisar({ hoy: HOY_FIJO, repo: tmp, base }); }
    finally { nombres.forEach((k, i) => { if (antes[i] === undefined) delete process.env[k]; else process.env[k] = antes[i]; }); }
  })();
  // (d1b) el MISMO hallazgo, pero escrito por `write-findings` con su `tramo`: eso
  // quiere decir que el firmante se validó contra el registro al escribirlo, así que la
  // incoherencia es REAL y frena sin necesidad de la llave. Es cómo la regla vuelve sola a frenar
  // a medida que las corridas del formato viejo dejan de cerrarse.
  fs.writeFileSync(path.join(runPost, 'findings.json'), JSON.stringify([{ advisor: 'fantasma', rule_id: 'X-1', tramo: 'revision' }]));
  const incoherenteValidado = revisar({ hoy: HOY_FIJO, repo: tmp, base });
  // (d2) las fuentes del propio pipeline no son revisores y NO pueden frenar
  fs.writeFileSync(path.join(runPost, 'findings.json'), JSON.stringify([
    { advisor: 'mech-check', rule_id: 'MECH-2' },
    { advisor: 'adversarial-verify:algorithmic-correctness', rule_id: 'ADV-1' },
    { advisor: 'tycon-plugin-security-basics', rule_id: 'SEC-C1' },
  ]));
  const sinteticas = revisar({ hoy: HOY_FIJO, repo: tmp, base });
  // (e) roster ilegible → frena siempre
  fs.rmSync(path.join(runPost, 'findings.json'));
  fs.writeFileSync(path.join(runPost, 'review-roster.json'), '{ esto no es json');
  const ilegible = revisar({ hoy: HOY_FIJO, repo: tmp, base });
  // (f) run ANTERIOR al corte y sin roster → no se le puede reclamar
  fs.rmSync(runPost, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, '.advisors', 'pipeline-runs', '1.1-20260825120000'), { recursive: true });
  const preCutoff = revisar({ hoy: HOY_FIJO, repo: tmp, base });
  // (g) la OTRA forma real del nombre (`-YYYYMMDD-HHMM`): también es una fecha, y también es vieja.
  // Leerla mal dejaría el run "sin fecha" y lo frenaría.
  fs.rmSync(path.join(tmp, '.advisors', 'pipeline-runs', '1.1-20260825120000'), { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, '.advisors', 'pipeline-runs', '1.1-20260824-1200'), { recursive: true });
  const preCutoffConHora = revisar({ hoy: HOY_FIJO, repo: tmp, base });
  // (h) un nombre SIN fecha (otra convención de repo) tampoco se reclama
  fs.rmSync(path.join(tmp, '.advisors', 'pipeline-runs', '1.1-20260824-1200'), { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, '.advisors', 'pipeline-runs', '1.1-corrida-manual'), { recursive: true });
  const sinFecha = revisar({ hoy: HOY_FIJO, repo: tmp, base });

  // ── Modo `--staged`: el MISMO control, antes de que el commit exista ───────────
  // Caso: una story que entra declarándose `review` con su código sin pushear. El freno local
  // que cubre ese caso vive en un hook de Claude Code: un commit hecho desde la
  // terminal, desde el botón de VS Code o desde la web se lo saltea SIN ENTERARSE. Medido contra
  // el índice, en cambio, lo corre git — que corre siempre, use quien use la herramienta que use.
  fs.rmSync(path.join(tmp, '.advisors'), { recursive: true, force: true });
  conStory(story('in-progress'));                        // punto de partida, ya commiteado
  fs.writeFileSync(path.join(tmp, 'specs', 'stories', '1-1.md'), story('review'));
  sh('add', '-A');                                       // en el índice, SIN commitear
  const stagedSinEvidencia = revisar({ hoy: HOY_FIJO, repo: tmp, staged: true });

  fs.mkdirSync(path.join(tmp, '.advisors', 'dod-runtime'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.advisors', 'dod-runtime', '1.1-20260904.md'), 'evidencia');
  const stagedConEvidencia = revisar({ hoy: HOY_FIJO, repo: tmp, staged: true });

  // 🔴 Lo que YA está commiteado no se vuelve a reclamar. Sin esto, cada commit posterior del repo
  // frenaría por una story cerrada hace semanas — y un freno que muerde sin motivo se apaga en una
  // semana. El índice es lo que está por entrar, nada más.
  sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'review + evidencia');
  fs.rmSync(path.join(tmp, '.advisors'), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'otro.md'), '# nada que ver\n');
  sh('add', '-A');
  const stagedOtraCosa = revisar({ hoy: HOY_FIJO, repo: tmp, staged: true });

  // 🔴 `review → done` en `--staged` AVISA y no frena: la decisión
  // tiene que vivir en las dos copias, o el aviso del skill es inerte. Con la llave, frena.
  sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'otra cosa');
  conStory(story('in-progress'));
  conStory(story('review'));                            // HEAD = review, commiteado
  fs.rmSync(path.join(tmp, '.advisors'), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'specs', 'stories', '1-1.md'), story('done'));
  sh('add', '-A');
  const stagedInterna = revisar({ hoy: HOY_FIJO, repo: tmp, staged: true });
  const llaveVieja = process.env.TYCON_REVIEW_A_DONE;
  process.env.TYCON_REVIEW_A_DONE = 'block';
  const stagedInternaFreno = revisar({ hoy: HOY_FIJO, repo: tmp, staged: true });
  if (llaveVieja === undefined) delete process.env.TYCON_REVIEW_A_DONE; else process.env.TYCON_REVIEW_A_DONE = llaveVieja;
  const ciInterna = revisar({ hoy: HOY_FIJO, repo: tmp, base });        // en el pull request sigue frenando
  let cliInterna = -1;
  try { execFileSync(process.execPath, [__filename, '--repo', tmp, '--staged'], { stdio: 'ignore' }); cliInterna = 0; }
  catch (e) { cliInterna = e.status; }

  // (j) el CLI en modo `--staged` tiene que SALIR 1: es lo único que git mira para frenar el
  // commit. Mismo aprendizaje que (i) — que el motor lo detecte no sirve de nada si el proceso
  // sale 0.
  //
  // 🔴 El estado se prepara con HEAD IGUAL a la base para esta story, a propósito: así el modo
  // viejo (comparar contra una rama) no ve absolutamente nada, y el 1 sólo puede venir de haber
  // mirado el índice. Un caso que no lo hiciera saldría verde CON LA
  // FUNCIONALIDAD DESACTIVADA — o sea, no probaría nada. Por eso va con su control al lado.
  conStory(story('in-progress'));
  fs.rmSync(path.join(tmp, '.advisors'), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'specs', 'stories', '1-1.md'), story('done'));
  sh('add', '-A');
  // No alcanza con mirar el código de salida: con la bandera sin cablear, el portón cae en
  // "no pude comparar contra `origin/main`" y sale 1 igual — el 1 correcto por el motivo
  // equivocado. Así que se le pide la salida y se exige que nombre la regla.
  let cliStaged = { code: 0, out: '' };
  try {
    cliStaged.out = execFileSync(process.execPath, [__filename, '--repo', tmp, '--staged', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { cliStaged = { code: e.status, out: String(e.stdout || '') }; }
  let cliSinStaged = -1;
  try {
    execFileSync(process.execPath, [__filename, '--repo', tmp, '--base', base], { stdio: 'ignore' });
    cliSinStaged = 0;
  } catch (e) { cliSinStaged = e.status; }

  // (i) 🔴 EL CLI DE VERDAD, no sólo el motor.
  // Todo lo de arriba llama a revisar() y mira su salida. Un atajo en main() que saliera 0 cuando no hay
  // stories en transición TIRARÍA los hallazgos — y el
  // frontmatter roto es justamente un hallazgo SIN transición. El motor diría "lo encontré" y el
  // proceso saldría 0. Un control se verifica por lo que el CI recibe: el código de salida.
  conStory('---\nstory: "1.1"\nstatus: done\n# falta el cierre\n');
  let cliSalida = 0;
  try {
    execFileSync(process.execPath, [__filename, '--repo', tmp, '--base', base], { stdio: 'ignore' });
  } catch (e) { cliSalida = e.status; }

  // ── Chequeo 5: el índice de memoria ───────────────────────────────────────────────
  // Este control es lo ÚNICO que ve los commits hechos fuera del asistente (la web de Azure, otra
  // máquina, un hook salteado): el freno del commit no los toca. Mismo criterio que el hook, misma
  // asimetría — lo que el pull request ROMPE frena; lo que ya venía roto avisa.
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-engram-'));
  const sh2 = (...a) => execFileSync('git', ['-C', tmp2, ...a], { stdio: 'ignore' });
  const commit2 = (m) => { sh2('add', '-A'); sh2('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', m); };
  const entrada = (id, mes) => ({ id, created_by: 't', created_at: `2026-${String(mes).padStart(2, '0')}-01T00:00:00Z`, sessions: 0, memories: 1, prompts: 0 });
  const escribirIndice = (ids) => fs.writeFileSync(path.join(tmp2, '.engram', 'manifest.json'),
    JSON.stringify({ version: 1, chunks: ids.map((id, i) => entrada(id, i + 1)) }, null, 2));
  const escribirChunk = (id) => fs.writeFileSync(path.join(tmp2, '.engram', 'chunks', `${id}.jsonl.gz`), zlib.gzipSync('{}\n'));

  fs.mkdirSync(path.join(tmp2, '.engram', 'chunks'), { recursive: true });
  sh2('init', '-q', '-b', 'main', '.');
  for (const id of ['aaaa1111', 'bbbb2222', 'cccc3333']) escribirChunk(id);
  escribirIndice(['aaaa1111', 'bbbb2222', 'cccc3333']);
  commit2('base sana: 3 de 3');
  const baseEngram = git(tmp2, ['rev-parse', 'HEAD']).trim();

  escribirIndice(['aaaa1111', 'bbbb2222']);          // el índice pierde una entrada
  commit2('el índice truncado entra al pull request');
  const prQuePierde = revisar({ hoy: HOY_FIJO, repo: tmp2, base: baseEngram });

  // Heredado: la base YA venía en deriva y el pull request no empeora nada (toca otra cosa de
  // `.engram/`, así que el chequeo igual mira).
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-engram2-'));
  const sh3 = (...a) => execFileSync('git', ['-C', tmp3, ...a], { stdio: 'ignore' });
  fs.mkdirSync(path.join(tmp3, '.engram', 'chunks'), { recursive: true });
  sh3('init', '-q', '-b', 'main', '.');
  for (const id of ['aaaa1111', 'bbbb2222', 'cccc3333']) fs.writeFileSync(path.join(tmp3, '.engram', 'chunks', `${id}.jsonl.gz`), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(tmp3, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1), entrada('bbbb2222', 2)] }, null, 2));
  sh3('add', '-A'); sh3('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'nace en deriva');
  const baseHeredada = git(tmp3, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(tmp3, '.engram', 'chunks', 'dddd4444.jsonl.gz'), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(tmp3, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1), entrada('bbbb2222', 2), entrada('dddd4444', 4)] }, null, 2));
  sh3('add', '-A'); sh3('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'agrega uno bien declarado');
  const prHeredado = revisar({ hoy: HOY_FIJO, repo: tmp3, base: baseHeredada });

  // Un diff que NO toca `.engram/`: el chequeo no lee nada (cero costo, cero ruido).
  fs.writeFileSync(path.join(tmp3, 'otra-cosa.txt'), 'x');
  sh3('add', '-A'); sh3('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'nada que ver');
  const baseSinEngram = git(tmp3, ['rev-parse', 'HEAD~1']).trim();
  const prSinEngram = revisar({ hoy: HOY_FIJO, repo: tmp3, base: baseSinEngram });

  // `--staged`: el mismo criterio antes de que el commit exista.
  escribirIndice(['aaaa1111']);                       // pierde otra más, sin commitear
  sh2('add', '-A');
  const stagedQuePierde = revisar({ hoy: HOY_FIJO, repo: tmp2, staged: true });

  // La referencia vieja ilegible: avisa, no frena. Nunca se rechaza un pull request por lo que no
  // se pudo comparar, y nunca se lo da por bueno por eso mismo.
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-engram3-'));
  const sh4 = (...a) => execFileSync('git', ['-C', tmp4, ...a], { stdio: 'ignore' });
  fs.mkdirSync(path.join(tmp4, '.engram', 'chunks'), { recursive: true });
  sh4('init', '-q', '-b', 'main', '.');
  fs.writeFileSync(path.join(tmp4, '.engram', 'chunks', 'aaaa1111.jsonl.gz'), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(tmp4, '.engram', 'manifest.json'), '{"version":1,"chunks":[');   // roto
  sh4('add', '-A'); sh4('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base con el índice roto');
  const baseIlegible = git(tmp4, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(tmp4, '.engram', 'chunks', 'bbbb2222.jsonl.gz'), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(tmp4, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1)] }, null, 2));
  sh4('add', '-A'); sh4('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'ahora el índice parsea');
  const prBaseIlegible = revisar({ hoy: HOY_FIJO, repo: tmp4, base: baseIlegible });

  // 🔴 Base de merge, no punta de main: main repara el índice DESPUÉS
  // del fork; la rama, abierta antes, ni tocó esos ids. Contra la punta saldrían como «perdidas».
  const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-engram4-'));
  const sh5 = (...a) => execFileSync('git', ['-C', tmp5, ...a], { stdio: 'ignore' });
  const commit5 = (m) => { sh5('add', '-A'); sh5('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', m); };
  fs.mkdirSync(path.join(tmp5, '.engram', 'chunks'), { recursive: true });
  sh5('init', '-q', '-b', 'main', '.');
  for (const id of ['aaaa1111', 'bbbb2222']) fs.writeFileSync(path.join(tmp5, '.engram', 'chunks', `${id}.jsonl.gz`), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(tmp5, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1)] }, null, 2));  // bbbb2222 huérfano heredado
  commit5('fork: 2 archivos, 1 entrada');
  sh5('checkout', '-q', '-b', 'rama');
  fs.writeFileSync(path.join(tmp5, '.engram', 'chunks', 'cccc3333.jsonl.gz'), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(tmp5, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1), entrada('cccc3333', 3)] }, null, 2));
  commit5('la rama agrega el suyo, bien declarado');
  sh5('checkout', '-q', 'main');
  fs.writeFileSync(path.join(tmp5, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1), entrada('bbbb2222', 2)] }, null, 2));
  commit5('main repara el huérfano después del fork');
  sh5('checkout', '-q', 'rama');
  const prContraMainReparado = revisar({ hoy: HOY_FIJO, repo: tmp5, base: 'main' });
  fs.rmSync(tmp5, { recursive: true, force: true });

  // 🔴 Los avisos del chequeo 5 llegan al CLI aunque no haya stories ni hallazgos:
  // el atajo «✅ ninguna story pasa a review/done» saldría ANTES de imprimirlos.
  // (tmp3 todavía existe acá: se borra más abajo junto con los otros). El aviso sale por stderr y el
  // CLI termina en 0, así que se capturan las DOS salidas con spawnSync — execFileSync sólo devuelve
  // stdout cuando el código es 0.
  const cliAviso = require('child_process').spawnSync(process.execPath, [__filename, '--repo', tmp3, '--base', baseHeredada], { encoding: 'utf8' });
  const cliAvisoEngramOut = String(cliAviso.stdout || '') + String(cliAviso.stderr || '');

  // 🔴 Sin base de merge (historias sin ancestro común, clon shallow) → AVISA, no cae a la punta.
  const tmp6 = fs.mkdtempSync(path.join(os.tmpdir(), 'cigate-engram5-'));
  const sh6 = (...a) => execFileSync('git', ['-C', tmp6, ...a], { stdio: 'ignore' });
  fs.mkdirSync(path.join(tmp6, '.engram', 'chunks'), { recursive: true });
  sh6('init', '-q', '-b', 'main', '.');
  for (const id of ['aaaa1111', 'bbbb2222']) fs.writeFileSync(path.join(tmp6, '.engram', 'chunks', `${id}.jsonl.gz`), zlib.gzipSync('{}\n'));
  fs.writeFileSync(path.join(tmp6, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1), entrada('bbbb2222', 2)] }, null, 2));
  sh6('add', '-A'); sh6('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'main: 2 de 2');
  sh6('checkout', '-q', '--orphan', 'huerfana');                       // historia SIN ancestro común
  fs.writeFileSync(path.join(tmp6, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1)] }, null, 2));
  sh6('add', '-A'); sh6('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'huérfana: 1 de 2');
  const prSinBaseComun = revisar({ hoy: HOY_FIJO, repo: tmp6, base: 'main' });
  fs.rmSync(tmp6, { recursive: true, force: true });

  // 🔴 Un archivo MOVIDO fuera de `.engram/` no esquiva el chequeo. `git diff --name-only` empareja el borrado con el
  // alta y lista sólo la ruta NUEVA: la vieja, que es
  // la que decide si el chequeo corre, no aparecería. Mover el índice (o un chunk) a otra carpeta dejaría la memoria sin
  // índice (o el índice con una entrada sin archivo) y el portón no diría nada. Dos repos: uno por el pull request,
  // otro por `--staged`.
  const memoryRepo = (prefix) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const sh = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
    fs.mkdirSync(path.join(d, '.engram', 'chunks'), { recursive: true });
    sh('init', '-q', '-b', 'main', '.');
    for (const id of ['aaaa1111', 'bbbb2222']) fs.writeFileSync(path.join(d, '.engram', 'chunks', `${id}.jsonl.gz`), zlib.gzipSync(`{"id":"${id}"}\n`));
    fs.writeFileSync(path.join(d, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [entrada('aaaa1111', 1), entrada('bbbb2222', 2)] }, null, 2));
    sh('add', '-A'); sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base sana: 2 de 2');
    fs.mkdirSync(path.join(d, 'backup'));
    return { d, sh };
  };
  const tmp7 = memoryRepo('cigate-engram6-');
  const movedIndexBase = git(tmp7.d, ['rev-parse', 'HEAD']).trim();
  tmp7.sh('mv', '.engram/manifest.json', 'backup/manifest.json');
  tmp7.sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'el índice se muda de carpeta');
  const movedIndexPr = revisar({ hoy: HOY_FIJO, repo: tmp7.d, base: movedIndexBase });
  const tmp8 = memoryRepo('cigate-engram7-');
  tmp8.sh('mv', '.engram/chunks/bbbb2222.jsonl.gz', 'backup/bbbb2222.jsonl.gz');   // stageado, sin commitear
  const movedChunkStaged = revisar({ hoy: HOY_FIJO, repo: tmp8.d, staged: true });
  // el espejo: mover algo que no es de la memoria sigue sin leer nada del índice
  const tmp9 = memoryRepo('cigate-engram8-');
  fs.writeFileSync(path.join(tmp9.d, 'note.txt'), 'una nota cualquiera, con texto suficiente para que git la empareje\n');
  tmp9.sh('add', '-A'); tmp9.sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'una nota');
  const movedNoteBase = git(tmp9.d, ['rev-parse', 'HEAD']).trim();
  tmp9.sh('mv', 'note.txt', 'backup/note.txt');
  tmp9.sh('-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'la nota se muda');
  const movedNotePr = revisar({ hoy: HOY_FIJO, repo: tmp9.d, base: movedNoteBase });
  for (const t of [tmp7, tmp8, tmp9]) fs.rmSync(t.d, { recursive: true, force: true });

  let cliEngram = 0;
  try { execFileSync(process.execPath, [__filename, '--repo', tmp2, '--base', baseEngram], { stdio: 'ignore' }); }
  catch (e) { cliEngram = e.status; }
  // Sale 1 (hay hallazgo), así que execFileSync tira: el JSON viene igual por stdout.
  let jsonEngram = {};
  try { jsonEngram = JSON.parse(execFileSync(process.execPath, [__filename, '--repo', tmp2, '--base', baseEngram, '--json'], { encoding: 'utf8' })); }
  catch (e) { try { jsonEngram = JSON.parse(String(e.stdout || '{}')); } catch { jsonEngram = {}; } }

  for (const d of [tmp2, tmp3, tmp4]) fs.rmSync(d, { recursive: true, force: true });

  fs.rmSync(tmp, { recursive: true, force: true });
  const reglas = (r) => r.hallazgos.map((h) => h.regla).sort();
  const checks = [
    ['una story a `done` sin nada en el repo → dos hallazgos', JSON.stringify(reglas(sinNada)) === JSON.stringify(['sin-constancia-de-revisores', 'sin-evidencia-de-cierre'])],
    ['🔴 la matriz, el self-audit y el plan manual solos NO son evidencia de cierre', reglas(soloMatriz).includes('sin-evidencia-de-cierre')],
    ['🔴 el ledger de smokes solo SÍ es evidencia de cierre (decisión del dev, 2026-09-06)', !reglas(conLedger).includes('sin-evidencia-de-cierre')],
    ['el gate E2E del proyecto (`<id>-e2e-gate-*.md`) sí lo es', !reglas(conGate).includes('sin-evidencia-de-cierre')],
    ['el smoke driven de UI (`<id>-ui-smoke-*.md`) también', !reglas(conUiSmoke).includes('sin-evidencia-de-cierre')],
    ['con evidencia de cierre queda sólo el de revisores', JSON.stringify(reglas(soloDod)) === JSON.stringify(['sin-constancia-de-revisores'])],
    ['con las dos cosas, limpio', completo.hallazgos.length === 0],
    ['las exenciones declaradas del dev se respetan', exenta.hallazgos.length === 0],
    ['un frontmatter que no cierra se caza (las tools lo saltean en silencio)', reglas(roto).includes('frontmatter-roto')],
    ['una story que NO transiciona no se revisa', sinTransicion.revisadas.length === 0 && sinTransicion.hallazgos.length === 0],
    ['un reporte que menciona `story:` en el CUERPO no es una story rota', !medicion.hallazgos.some((h) => h.regla === 'frontmatter-roto')],
    ['un run posterior al corte SIN registro de autoría frena', reglas(postSinRoster).includes('sin-registro-de-autoria')],
    ['con el registro de autoría válido, limpio', postConRoster.hallazgos.length === 0],
    ['si el que implementó figura como revisor, frena', reglas(autoRevision).includes('revisor-es-el-autor')],
    // 🔴 La regla AVISA y no frena: lo que falló fue la regla, no lo que vigila. El caso no se borra
    // —sigue midiendo que la ve— y el canal es parte de lo que se afirma. Con TYCON_ROSTER_NAMES=block vuelve a hallazgos.
    ['un advisor con hallazgos que el registro no lista, AVISA y no frena',
      (incoherente.avisos || []).some((h) => h.regla === 'roster-incoherente')
      && !reglas(incoherente).includes('roster-incoherente')],
    ['…y con TYCON_ROSTER_NAMES=block vuelve a frenar', reglas(incoherenteFreno).includes('roster-incoherente')],
    // 🔴 La regla vuelve a frenar SOLA para lo que nació validado, sin llave y sin
    // día de corte: el hallazgo que trae su `tramo` pasó por la validación al escribirse.
    ['un hallazgo que SÍ se validó al escribirse (trae su tramo) frena sin llave',
      reglas(incoherenteValidado).includes('roster-incoherente')
      && !(incoherenteValidado.avisos || []).some((h) => h.regla === 'roster-incoherente')],
    ['las fuentes del propio pipeline (mech-check, adversarial-verify) NO frenan', sinteticas.hallazgos.length === 0],
    ['un registro ilegible frena (dato malo es peor que dato ausente)', reglas(ilegible).includes('registro-de-autoria-invalido')],
    ['un run ANTERIOR al corte sin registro no se reclama', !reglas(preCutoff).includes('sin-registro-de-autoria')],
    ['la otra forma del nombre (-YYYYMMDD-HHMM) también se lee como fecha', !reglas(preCutoffConHora).includes('sin-registro-de-autoria')],
    ['un run dir sin fecha en el nombre no se reclama', !reglas(sinFecha).includes('sin-registro-de-autoria')],
    ['🔴 el CLI SALE 1 con un frontmatter roto (no alcanza con que el motor lo detecte)', cliSalida === 1],
    ['🔴 --staged: una story que pasa a review en el ÍNDICE se caza antes del commit', reglas(stagedSinEvidencia).includes('sin-evidencia-de-cierre')],
    ['--staged: con su evidencia en el repo, limpio', stagedConEvidencia.hallazgos.length === 0],
    ['🔴 --staged: lo YA commiteado no se vuelve a reclamar en cada commit', stagedOtraCosa.revisadas.length === 0 && stagedOtraCosa.hallazgos.length === 0],
    ['🔴 el CLI --staged SALE 1 nombrando la regla (no por no poder comparar)', cliStaged.code === 1 && /sin-evidencia-de-cierre/.test(cliStaged.out)],
    ['…y sin la bandera, el MISMO estado sale 0 (el 1 vino de mirar el índice, no de otra cosa)', cliSinStaged === 0],
    ['🔴 --staged: `review → done` sin evidencia AVISA (queda en avisos, no en hallazgos)', stagedInterna.hallazgos.length === 0 && (stagedInterna.avisos || []).some((h) => h.regla === 'sin-evidencia-de-cierre')],
    ['--staged + TYCON_REVIEW_A_DONE=block: `review → done` FRENA', reglas(stagedInternaFreno).includes('sin-evidencia-de-cierre')],
    ['en el pull request (sin --staged) `review → done` sigue frenando', reglas(ciInterna).includes('sin-evidencia-de-cierre')],
    ['el CLI --staged SALE 0 ante `review → done` (avisa, no frena)', cliInterna === 0],
    // ── chequeo 5: el índice de memoria ──────────────────────────────────────────
    ['🔴 un PR que PIERDE entradas del índice de memoria frena, nombrando el id', reglas(prQuePierde).includes('indice-de-memoria-perdio-entradas')
      && prQuePierde.hallazgos.some((h) => /cccc3333/.test(h.mensaje))],
    ['la deriva HEREDADA del índice avisa y no frena (el PR no la causó)', prHeredado.hallazgos.length === 0
      && (prHeredado.avisos || []).some((h) => h.regla === 'indice-de-memoria-en-deriva')],
    ['un diff que no toca `.engram/` no lee nada del índice (cero costo, cero ruido)',
      prSinEngram.hallazgos.length === 0 && !(prSinEngram.avisos || []).some((h) => /indice-de-memoria/.test(h.regla)) && prSinEngram.engram === undefined],
    ['🔴 --staged: el mismo criterio antes de que el commit exista', reglas(stagedQuePierde).includes('indice-de-memoria-perdio-entradas')],
    ['la referencia vieja ilegible AVISA y no frena (ni lo da por bueno)', prBaseIlegible.hallazgos.length === 0
      && (prBaseIlegible.avisos || []).some((h) => h.regla === 'indice-de-memoria-no-comparable')],
    ['el CLI sale 1 y `--json` trae el bloque del chequeo 5', cliEngram === 1 && !!jsonEngram.engram && jsonEngram.engram.perdidas.includes('cccc3333')],
    ['🔴 se compara contra la BASE DE MERGE: main que repara el índice después del fork no frena a la rama', prContraMainReparado.hallazgos.length === 0],
    ['🔴 sin base de merge (historias sin ancestro común) AVISA «no pude comparar» — no cae a la punta ni frena', prSinBaseComun.hallazgos.length === 0
      && (prSinBaseComun.avisos || []).some((h) => h.regla === 'indice-de-memoria-no-comparable' && /base de merge/.test(h.mensaje))],
    ['🔴 un PR que MUEVE el índice de memoria a otra carpeta no esquiva el chequeo 5: avisa que no pudo comparar',
      (movedIndexPr.avisos || []).some((h) => h.regla === 'indice-de-memoria-no-comparable')],
    ['🔴 --staged: un chunk MOVIDO fuera de `.engram/chunks/` no esquiva el chequeo 5: la entrada sin archivo se avisa',
      (movedChunkStaged.avisos || []).some((h) => h.regla === 'indice-de-memoria-en-deriva' && /bbbb2222/.test(h.mensaje))],
    ['mover un archivo que no es de la memoria sigue sin leer nada del índice',
      movedNotePr.hallazgos.length === 0 && !(movedNotePr.avisos || []).some((h) => /indice-de-memoria/.test(h.regla)) && movedNotePr.engram === undefined],
    ['🔴 los avisos del chequeo 5 LLEGAN al CLI aunque no haya stories (el atajo ✅ no se los traga)', /indice-de-memoria/.test(cliAvisoEngramOut) && !/ninguna story pasa a review\/done/.test(cliAvisoEngramOut)],
  ];
  let bad = 0;
  for (const [n, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-ci-gate: ${n}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ selftest-ci-gate: ${checks.length}/${checks.length} verdes`);
  return bad ? 1 : 0;
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const arg = (n, def) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
  const repo = path.resolve(arg('--repo', process.cwd()));
  // `--staged` = el mismo control, corrido por git antes de que el commit exista. Ignora `--base`
  // a propósito: en un pre-commit lo de antes es siempre el último commit, no una rama remota.
  const staged = process.argv.includes('--staged');
  const base = arg('--base', process.env.TYCON_CI_BASE || 'origin/main');
  const r = revisar({ repo, base, staged });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ repo, base: staged ? 'HEAD' : base, staged, ...r }, null, 2));
    return r.error || r.hallazgos.length ? 1 : 0;
  }
  if (r.error) {
    console.error(`⚠ tycon-ci-gate: ${r.error} — no se pudo revisar nada. NO se da por bueno.`);
    return 1;
  }
  // 🔴 `&& !r.hallazgos.length`: un atajo que saliera 0 en cuanto no hay stories EN TRANSICIÓN, sin mirar los
  // hallazgos, tiraría el hallazgo de `frontmatter-roto`, que aparece SIN transición: una story cuyo frontmatter
  // no se puede leer no puede verse pasando a `done`, por definición. El CI vería ✅ y exit 0; el
  // mismo input con --json saldría 1.
  const dondeMira = staged ? 'lo que estás por commitear' : 'este diff';
  // 🔴 El atajo verde sólo vale si TAMPOCO hay avisos: si saliera
  // antes del bloque de avisos, todo aviso del chequeo 5 —«no pude comparar el índice de
  // memoria», «deriva heredada»— se tragaría y el portón imprimiría ✅. Nunca se da por bueno
  // lo que no se pudo medir.
  if (r.engram && r.engram.estado === 'indice-local') console.log(`ℹ️  índice de memoria: ${r.engram.motivo} (no se compara).`);
  // Lo que dice toda línea verde: el visto bueno es «hay archivos con el nombre correcto y lo que el servidor verificó
  // él mismo», no «se probó».
  const SIN_REEJECUTAR = 'El servidor no re-ejecutó nada: no compiló, no corrió pruebas ni levantó la app.';
  if (!r.revisadas.length && !r.hallazgos.length && !(r.avisos || []).length) {
    console.log(`✅ tycon-ci-gate: ninguna story pasa a review/done en ${dondeMira} (${r.archivos} .md mirados). ${SIN_REEJECUTAR}`);
    return 0;
  }
  const verif = r.verificacion || [];
  const enPalabras = (lista) => lista.map((v) => `${v.chequeo.replace(/-/g, ' ')}: ${NIVEL_EN_PALABRAS[v.nivel] || v.nivel}${v.detalle ? `: ${v.detalle}` : ''}`).join(' · ');
  if (r.revisadas.length) {
    console.log(`tycon-ci-gate: ${r.revisadas.length} story(s) declarándose lista(s):`);
    for (const s of r.revisadas) {
      console.log(`   · ${s.story} (${s.de} → ${s.a}) — ${s.archivo}`);
      const deLaStory = verif.filter((v) => v.archivo === s.archivo);
      if (deLaStory.length) console.log(`     chequeos: ${enPalabras(deLaStory)}`);
    }
  }
  const delRepo = verif.filter((v) => v.story === null);
  if (delRepo.length) console.log(`   chequeos del repo: ${enPalabras(delRepo)}`);
  const exen = r.exenciones || [];
  if (exen.length) {
    console.log(`   ${exen.length} exención(es): ${exen.map((e) => `${e.campo} (razón: ${e.razon ? textoDeAfuera(e.razon) : 'FALTA'})`).join(' · ')}`);
    console.log('   (la razón la escribe la story; el servidor no sabe quién autorizó la exención)');
  }
  for (const a of r.aprobaciones || []) {
    const total = a.manual + a.automatica;
    if (!total) continue;
    console.log(`   aprobaciones de ${a.story}: ${a.manual} ${a.manual === 1 ? 'manual' : 'manuales'} · ${a.automatica} ${a.automatica === 1 ? 'automática' : 'automáticas'}${a.sinNombrar ? ` (${a.sinNombrar} sin nombrar)` : ''}`);
  }
  const avisosDeStory = (r.avisos || []).filter((h) => !/^indice-de-memoria/.test(h.regla) && h.regla !== 'roster-incoherente' && h.regla !== 'storyid-sin-story' && !/^reviewer-/.test(h.regla) && h.regla !== 'sin-registro-de-aprobaciones' && h.regla !== 'exencion-sin-razon' && !h.porFecha && h.regla !== 'carpeta-fecha-contradictoria');
  // Lo que el portón empieza a frenar con la lectura por git y del veredicto: su propio bloque, por la fecha.
  const avisosPorFecha = (r.avisos || []).filter((h) => h.porFecha);
  if (avisosPorFecha.length) {
    console.error(`\n⚠️  AVISO — lo que el portón empieza a frenar (avisa hasta el ${STRICT_EVIDENCE_FROM}; desde ese día frena):`);
    for (const h of avisosPorFecha) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
  }
  const avisosDeFecha = (r.avisos || []).filter((h) => h.regla === 'carpeta-fecha-contradictoria');
  if (avisosDeFecha.length) {
    console.error('\n⚠️  AVISO — carpetas de ejecución cuya fecha en el nombre no coincide con la de git (no frena):');
    for (const h of avisosDeFecha) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
  }
  // Su propio bloque: no depende de `review → done` ni de TYCON_REVIEW_A_DONE, sino de una fecha.
  const avisosDeExencion = (r.avisos || []).filter((h) => h.regla === 'exencion-sin-razon');
  if (avisosDeExencion.length) {
    console.error(`\n⚠️  AVISO — exenciones sin su razón (avisa hasta el ${EXEMPT_REASON_FROM}; desde ese día frena):`);
    for (const h of avisosDeExencion) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
  }
  const avisosDeAprobaciones = (r.avisos || []).filter((h) => h.regla === 'sin-registro-de-aprobaciones');
  if (avisosDeAprobaciones.length) {
    console.error('\n⚠️  AVISO — ejecuciones sin registro de aprobaciones (no frena):');
    for (const h of avisosDeAprobaciones) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
  }
  // Este aviso tiene su propio encabezado: el de `review → done` no le corresponde, porque no depende de
  // TYCON_REVIEW_A_DONE=block ni del pull request.
  const avisosDeStoryId = (r.avisos || []).filter((h) => h.regla === 'storyid-sin-story');
  if (avisosDeStoryId.length) {
    console.error('\n⚠️  AVISO — archivos que se parecen a una story pero el arnés no los trata como tal:');
    for (const h of avisosDeStoryId) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
    console.error('   Avisa y no frena, en ningún lado: un archivo con `storyId:` puede no ser una story.');
  }
  const avisosDeMemoria = (r.avisos || []).filter((h) => /^indice-de-memoria/.test(h.regla));
  // Su propio bloque: el encabezado de los otros avisos habla de `review → done`, y éste no tiene
  // nada que ver con esa transición. Un aviso bajo el título equivocado se lee como otra cosa.
  const avisosDeNombres = (r.avisos || []).filter((h) => h.regla === 'roster-incoherente');
  if (avisosDeNombres.length) {
    console.error('\n⚠️  AVISO — el registro de revisores no coincide con quién firmó los hallazgos:');
    for (const h of avisosDeNombres) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
    console.error('   Avisa y no frena desde el 2026-09-22: en sus dos apariciones falló ella, no lo');
    console.error('   que vigila (la última frenó 5 stories sanas de un producto). Las otras');
    console.error('   reglas del registro —que exista, que se lea, que el autor no sea el revisor—');
    console.error('   siguen frenando. Vuelve a frenar con TYCON_ROSTER_NAMES=block.');
  }
  const avisosDeRevisores = (r.avisos || []).filter((h) => /^reviewer-/.test(h.regla));
  if (avisosDeRevisores.length) {
    console.error('\n⚠️  AVISO — cambios de revisores (no frena):');
    for (const h of avisosDeRevisores) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
  }
  if (avisosDeStory.length) {
    console.error(`\n⚠️  AVISO — review → done sin evidencia completa (hoy avisa; con TYCON_REVIEW_A_DONE=block bloquea):`);
    for (const h of avisosDeStory) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
    console.error('   Es la transición interna: el paso a `review` ya se juzgó. El portón del pull request SÍ la frena.');
  }
  if (avisosDeMemoria.length) {
    console.error(`\n⚠️  AVISO — el índice de memoria de engram (no frena, pero NO es «está bien»):`);
    for (const h of avisosDeMemoria) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
  }
  if (!r.hallazgos.length) { console.log(`${r.avisos && r.avisos.length ? '✅ Nada que frene (el aviso de arriba se mide, no frena).' : '✅ Todas traen su evidencia en el repo: los archivos con el nombre correcto y lo que el servidor verificó él mismo (arriba, chequeo por chequeo).'} ${SIN_REEJECUTAR}`); return 0; }
  console.error(`\n❌ tycon-ci-gate — ${r.hallazgos.length} problema(s):`);
  for (const h of r.hallazgos) console.error(`   · [${h.regla}] ${h.archivo}: ${h.mensaje}`);
  if (staged) {
    console.error('\n   Esto todavía no se commiteó: arreglalo ahora y volvé a intentar. Si de verdad');
    console.error('   corresponde, la salida es declararlo en el frontmatter de la story (arriba dice');
    console.error('   cuál), que queda escrito y se ve en el pull request. El portón del servidor va a');
    console.error('   pedir exactamente lo mismo cuando el commit llegue.');
  } else {
    // 🔴 Este texto no afirma dónde corre cada capa: un mensaje de error que afirma dónde corre otra capa se pudre
    // con el próximo cambio (por ejemplo, `roster-incoherente` tiene su contraparte local en `revisarRosterLocal` de
    // `on-pre-commit.js`). Dice lo único que este proceso sabe de verdad: que el commit llegó hasta acá.
    console.error('\n   Estos controles tienen contraparte en la máquina, en el pre-commit del arnés.');
    console.error('   Que hayan llegado acá significa que ese commit no pasó por ella: otra máquina,');
    console.error('   la web de Azure DevOps, hooks salteados, o una copia del arnés desactualizada.');
    console.error('   (`roster-incoherente` en la máquina AVISA y no frena, salvo TYCON_ROSTER_NAMES=block:');
    console.error('   podés haber commiteado con el aviso delante.)');
  }
  return 1;
}

// 🔴 `process.exitCode`, NO `process.exit()`. Este guión lo ejecuta otro proceso y le parsea la
// salida; en Node las escrituras a una tubería son ASINCRÓNICAS y `process.exit()` mata el proceso
// con parte de lo escrito todavía en el aire: un informe de ~9800 bytes llega cortado en 8192 y el consumidor lo
// lee como «no pude», nunca como un error. `main` acá es sincrónica y no deja manejadores abiertos, así que con `exitCode` el
// proceso termina solo, cuando terminó de escribir.
if (require.main === module) process.exitCode = main();
// `mdDelDiff` y `contenidoEn` se exportan para que `cierre-recortado` T12 pueda
// EJECUTARLAS en vez de comparar sus bytes contra `main`. Comparar texto no distingue una mejora
// de un deterioro: cualquier cambio sale rojo.
module.exports = { EXEMPT_REASON_FROM, STRICT_EVIDENCE_FROM, evidenciaDeclaraFail, fechaDeCarpeta, NIVELES, nivelDelExamen, nivelDeBusqueda, nivelDelIndice, razonDe, llaveFrena, revisar, revisarAprobaciones, frontmatter, declaraSerStory, escalar, hayEvidencia, prefijoDeEvidencia, runDirsDeStory, validarRoster, advisoresEnFindings, FUENTES_SINTETICAS, esEvidenciaDeCierre, NO_ES_EVIDENCIA_DE_CIERRE, ES_EVIDENCIA_ADEMAS, mdDelDiff, contenidoEn };
