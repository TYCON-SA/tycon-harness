'use strict';

/**
 * config-lint.js — chequeo determinístico de `.tycon/advisors.yaml`.
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * La config del repo es una **superficie de control sin control**: cambiarla cambia qué frenos
 * corren y sobre qué, y nada la mira. Los tres modos de falla que
 * detecta son SILENCIOSOS:
 *
 *   1. **Llave que nadie lee.** Un repo puede declarar una lista `advisors:` que
 *      NINGUNA parte del arnés consulta. No da error — da la impresión de que el repo está
 *      configurado, y nadie revisa si los revisores que hacen falta corren de verdad.
 *   2. **Regla publicada y muerta.** `e2e_realness.dev_seam_pattern` es el GATE de una regla
 *      CRITICAL: si el patrón no matchea ningún spec del repo, la regla está declarada y no puede
 *      disparar nunca. Se lee como "salió limpio".
 *   3. **Cobertura que se achica de a poco.** `e2e_realness.business_endpoint_excludes` AFLOJA dos
 *      reglas CRITICAL, una entrada por vez. Cada línea agregada es una decisión de bajar cobertura
 *      que hoy pasa como un cambio de config cualquiera. **Ése es el diff que hay que mirar.**
 *
 * ── QUÉ NO ES ───────────────────────────────────────────────────────────────────────────────────
 * No corre ningún modelo, no llama a la red y no bloquea: es una pasada de texto de ~50ms y cero
 * tokens. AVISA. Un lint de config que frena commits se apaga en una semana, y se lleva puestos los
 * casos donde sí importaba.
 */

const fs = require('fs');
const path = require('path');

/**
 * EL CATÁLOGO: las llaves que el arnés LEE y QUIÉN las lee.
 *
 * 🔴 Cada entrada se verifica contra su lector real — no contra la documentación.
 * Un catálogo escrito de memoria da falsos positivos: el bloque `i18n:` completo y `visual_plan`
 * sí los lee el advisor de i18n y el paso del plan. Un lint que pone en rojo config legítima se apaga en una semana.
 *
 * 🔴 Al agregar una llave nueva al arnés, agregarla ACÁ con su lector. Si no, el lint la va a
 * reportar como desconocida en todos los repos que la usen.
 *
 * `null` = escalar de primer nivel · `libres` = llaves cuyo contenido anidado lo define el proyecto
 * (ej. `i18n.audiences`, que es un mapa audiencia→idioma).
 */
const ESQUEMA = {
  repo_group: null,       // ~/.claude/tycon-harness/scripts/hooks/unpushed-work-notice.js (grupo de
                          // repos del aviso de trabajo sin subir) + el arranque de tycon-merge-to-main.
                          // Sin esta entrada, el lint reporta la llave como desconocida en todos
                          // los repos que la usan — el propio test 'los 13 configs reales del
                          // equipo no disparan NADA' queda en rojo.
  visual_plan: null,      // tycon-pipeline SKILL.md G.ii / paso «Aprobar el plan» / scripts/visual-plan.js
  qa_guide: null,         // lib/atdd-commit-gate.js → qaGuideMode
  deep_review: null,      // pipeline.js → deepReviewConfig
  deep_review_always_paths: null,  // pipeline.js → deepReviewAlwaysPaths (superficie compartida
                          // del repo: el diff que la toca corre el pase adversarial aunque el
                          // risk-class dé LOW). Lista de globs; el valor de la llave va vacío.
  i18n: {                 // agents/i18n-hardcoded-text-reviewer.md + pipeline.js → i18nRequired
    hijas: ['required', 'hook', 'locales_glob', 'backend_required', 'backend_mechanism',
      'audiences', 'shared_libs', 'spanish_variant'],
    libres: ['audiences'],
  },
  e2e: {                  // pipeline.js → e2eConfig · scripts/e2e-gate.sh (bundle, required_env)
    // `bundle` y `required_env` las lee el PORTÓN, no `e2eConfig`, y por eso hacen falta acá: `bundle` para
    // la frescura del artefacto y `required_env` para la llave exigente.
    // Medido: un repo que declare las dos se come CINCO avisos,
    // y tres de ellos le dicen mover al primer nivel las hijas de `bundle` — o sea, el lint manda
    // a ROMPER una config buena. Es el mismo modo de falla que el catálogo existe para cerrar, del lado
    // de adentro: una llave nueva en el arnés que nadie registró acá.
    hijas: ['gate', 'frontend_dir', 'frontend_dirs', 'critical_manifest', 'shared_paths',
      'preconditions', 'bundle', 'required_env'],
    // `bundle` va en libres porque sus hijas (artifact/sources/rebuild) viven un nivel más abajo y
    // este lint mira dos: aceptarlas es preferible a mandar a moverlas. El contrato de las tres está
    // en la cabecera de `e2e-gate.sh` y lo ejerce `e2e-gate-bundle.test.sh`.
    libres: ['bundle'],
  },
  e2e_realness: {         // agents/tycon-e2e-realness-checker.md
    hijas: ['dev_seam_pattern', 'business_endpoint_excludes', 'user_visible_keywords'],
    libres: [],
  },
  evidence: {             // lib/evidence-config.js
    hijas: ['companion_repos', 'fe_paths'],
    libres: [],
  },
  stories: {              // lib/story-discovery.js
    hijas: ['id_pattern'],
    libres: [],
  },
  pipeline: {             // lib/story-gate-io.js → gateEnabledForRepo(root, key)
    hijas: ['story_gate', 'story_skill_gate'],  // story_skill_gate: freno de story-a-mano
    libres: [],
  },
  merge: {                // tycon-merge-to-main step-00 / step-09b → merge.mode (push | pr)
    hijas: ['mode', 'check'],  // `check`: el control que espera un pedido de GitHub (lo lee scripts/tools/merge-pr.js del arnés).
                          // `mode` se registra porque los repos lo declaran: si no, el lint lo
    libres: [],           // acusaría de desconocido y el test de los configs
  },                      // reales del equipo quedaría en rojo (mismo patrón que repo_group).

  audit: {                // el revisor de convenciones .NET del paquete bizuit → DOTNET-W11
    hijas: ['interface', 'exclude_attribute'],
    libres: [],
  },
  packs: null,            // lib/packs.js → paquetesActivos: la lista EXACTA de paquetes
                          // de revisores activos en el repo. Sin la llave, están activos todos los
                          // instalados. Un nombre que no está instalado FRENA `pipeline.js advisors`;
                          // acá se avisa antes (lintPaquetes).
  deprecated: {           // lib/deprecated.js → leerLista: el código deprecado del repo (edit: warn|block; paths:
    hijas: ['edit', 'paths'],  // lista de entradas path/level/reason/review_by, que valida el lector, no este lint)
    libres: ['paths'],
  },
  frontend: {             // ~/.claude/tycon-harness/scripts/hooks/rebuild-before-verify.js
    hijas: ['dev_build_cmd', 'dir'],
    libres: [],
  },
};

/** Líneas `clave: valor` con su indentación. Ignora comentarios, vacías e items de lista. */
function claves(txt) {
  const out = [];
  for (const linea of String(txt || '').split(/\r?\n/)) {
    if (!linea.trim() || /^\s*#/.test(linea)) continue;
    if (/^\s*-/.test(linea)) continue;                       // item de lista
    const m = linea.match(/^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    out.push({ indent: m[1].length, key: m[2], valor: m[3].replace(/\s+#.*$/, '').trim() });
  }
  return out;
}

/** Items de una lista en bloque bajo `bloque.llave` (o flow style `[a, b]`). */
function lista(txt, bloque, llave) {
  const lineas = String(txt || '').split(/\r?\n/);
  const out = [];
  let enBloque = false; let indBloque = 0; let juntando = false;
  for (const l of lineas) {
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const ind = l.length - l.trimStart().length;
    if (!enBloque) {
      if (new RegExp(`^${bloque}\\s*:`).test(l)) { enBloque = true; indBloque = ind; }
      continue;
    }
    if (ind <= indBloque) break;
    const item = l.match(/^\s*-\s*(.+?)\s*$/);
    if (juntando && item) { out.push(item[1].replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim()); continue; }
    const kv = l.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    juntando = false;
    if (kv[1] !== llave) continue;
    const v = kv[2].replace(/\s+#.*$/, '').trim();
    if (v === '') { juntando = true; continue; }
    const flow = v.match(/^\[(.*)\]$/);
    if (flow) { for (const x of flow[1].split(',')) { const t = x.replace(/^['"]|['"]$/g, '').trim(); if (t) out.push(t); } continue; }
    out.push(v.replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

/** Escalar de `bloque.llave`, o null. */
function escalar(txt, bloque, llave) {
  const v = lista(txt, bloque, llave);
  return v.length === 1 ? v[0] : null;
}

/** ── (1) llaves que nadie lee ───────────────────────────────────────────────────────────────── */
/**
 * ── EL CATÁLOGO SE AUDITA A SÍ MISMO ────────────────────────────────────────────────────────────
 *
 * 🔴 El catálogo de arriba existe para cazar la llave que nadie lee. Dos propias se le escapan:
 * `e2e.bundle` y `e2e.required_env`, las dos leídas por `e2e-gate.sh` en vez de por `e2eConfig`. Un repo
 * que las declara se come cinco avisos, tres de ellos diciéndole que MUEVA líneas que están bien: el lint
 * manda a romper una config que funciona. Ninguna prueba lo ve, porque el caso de los configs reales del
 * equipo sólo mira lo que los repos YA declaran, y nadie las declara todavía.
 *
 * La regla escrita arriba —«al agregar una llave nueva, agregarla ACÁ»— depende de que alguien se
 * acuerde, que es la misma forma de falla que el arnés persigue en todo lo demás. Esto la mide:
 * busca en los archivos del arnés que LEEN la config los nombres de llave que parsean —los patrones
 * anclados de awk (`[[:space:]]*<nombre>:`) y de JavaScript (`\s*<nombre>\??:`)— y exige que cada
 * uno esté registrado. Una llave nueva sin registrar pone el caso en rojo el mismo día que se
 * escribe, no el día que un repo la usa.
 *
 * NO pretende encontrar toda forma de leer una llave (un `split(':')` a mano se le escapa): cubre
 * las dos formas con las que el arnés parsea hoy, que son las que producen este defecto. Si aparece
 * una tercera, entra acá con su caso.
 */

// Nombres que estos archivos parsean y que NO son llaves de `.tycon/advisors.yaml`: viven en el
// frontmatter de las stories o en la matriz de runtime. Cada uno con dónde vive, porque una lista de
// excepciones sin motivo se llena sola.
const NO_SON_DE_LA_CONFIG = {
  ac: 'frontmatter de la story / matriz de runtime',
  covered_by: 'matriz de runtime (runtime-matrix.js)',
  reason: 'matriz de runtime (runtime-matrix.js)',
  dod_runtime_exempt: 'frontmatter de la story',
  status: 'frontmatter de la story (on-frontmatter-write.js lee su estado)',
  fkey: 'clave interna de pipeline.js, no viene del YAML',
};

/** Los archivos del arnés que leen `.tycon/advisors.yaml` (sin las pruebas). */
function archivosQueLeenLaConfig(raizScripts) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'tests') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|sh)$/.test(e.name)) continue;
      let txt = '';
      try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (/advisors\.ya?ml/.test(txt)) out.push(p);
    }
  };
  walk(raizScripts);
  return out;
}

/**
 * Las llaves que el arnés parsea y el catálogo NO registra. `[]` = el catálogo está al día.
 * Devuelve `{ llave, archivos }` para que el rojo diga dónde se lee y no haya que buscarlo.
 */
function llavesSinRegistrar(raizScripts) {
  const registradas = new Set();
  for (const [bloque, def] of Object.entries(ESQUEMA)) {
    registradas.add(bloque);
    if (def && def.hijas) for (const h of def.hijas) registradas.add(h);
  }
  const vistas = new Map();
  for (const f of archivosQueLeenLaConfig(raizScripts)) {
    const s = fs.readFileSync(f, 'utf8');
    const add = (k) => { if (!vistas.has(k)) vistas.set(k, []); vistas.get(k).push(path.basename(f)); };
    for (const m of s.matchAll(/\[\[:space:\]\]\*([a-z_]+):/g)) add(m[1]);
    for (const m of s.matchAll(/\\s\*([a-z_]+)\\?\s*:/g)) add(m[1]);
  }
  const faltan = [];
  for (const [llave, archivos] of vistas) {
    if (registradas.has(llave) || NO_SON_DE_LA_CONFIG[llave]) continue;
    faltan.push({ llave, archivos: [...new Set(archivos)] });
  }
  return faltan.sort((a, b) => a.llave.localeCompare(b.llave));
}

function lintEsquema(txt) {
  const hallazgos = [];
  const ks = claves(txt);
  if (!ks.length) return hallazgos;
  const raiz = Math.min(...ks.map((k) => k.indent));
  let bloque = null; let indHijo = null; let ultimaHija = null;

  for (const k of ks) {
    if (k.indent === raiz) {
      bloque = k.key; indHijo = null; ultimaHija = null;
      if (!(k.key in ESQUEMA)) {
        hallazgos.push({
          tipo: 'llave-desconocida', llave: k.key,
          mensaje: `\`${k.key}:\` no la lee ninguna parte del arnés. Una llave desconocida no da error: se ignora, ` +
                   `y el repo queda con la impresión de estar configurado. Las que sí se leen: ${Object.keys(ESQUEMA).join(', ')}.`,
        });
      }
      continue;
    }
    const def = ESQUEMA[bloque];
    if (def === undefined || def === null) continue;   // bloque ya reportado, o escalar
    if (indHijo === null) indHijo = k.indent;
    if (k.indent > indHijo) {
      // Contenido de un mapa que define el PROYECTO (ej. i18n.audiences: operador→idioma).
      if (ultimaHija && def.libres.includes(ultimaHija)) continue;
      hallazgos.push({
        tipo: 'llave-anidada', llave: `${bloque}.…​.${k.key}`,
        mensaje: `\`${k.key}:\` está anidada más adentro de lo que el arnés lee dentro de \`${bloque}:\`. ` +
                 'No da error: configura otra cosa, o nada. Movela al primer nivel del bloque.',
      });
      continue;
    }
    ultimaHija = k.key;
    if (!def.hijas.includes(k.key)) {
      hallazgos.push({
        tipo: 'llave-desconocida', llave: `${bloque}.${k.key}`,
        mensaje: `\`${bloque}.${k.key}\` no existe en el arnés. Dentro de \`${bloque}:\` se leen: ${def.hijas.join(', ')}.`,
      });
    }
  }
  return hallazgos;
}

/** ── (2) regla publicada y muerta ───────────────────────────────────────────────────────────── */
function specsE2e(repoRoot, tope = 400) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= tope || depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const e of entries) {
      if (out.length >= tope) return;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isFile()) {
        if (/\.spec\.[cm]?[jt]sx?$/.test(e.name) && /(^|\/)(tests\/)?e2e\//.test(full)) out.push(full);
      } else if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(repoRoot, 0);
  return out;
}

function lintSeamMuerta(txt, repoRoot) {
  const patron = escalar(txt, 'e2e_realness', 'dev_seam_pattern');
  if (!patron) return [];
  let re;
  try { re = new RegExp(patron); } catch (e) {
    return [{ tipo: 'seam-invalida', llave: 'e2e_realness.dev_seam_pattern',
      mensaje: `el patrón no es una expresión regular válida (${e.message}) — REAL-C3 no puede correr.` }];
  }
  const specs = specsE2e(repoRoot);
  if (!specs.length) return [];   // repo sin specs: no hay nada que afirmar
  for (const f of specs) {
    let c = '';
    try { c = fs.readFileSync(f, 'utf8'); } catch (_e) { continue; }
    if (re.test(c)) return [];
  }
  return [{
    tipo: 'regla-muerta', llave: 'e2e_realness.dev_seam_pattern',
    mensaje: `el patrón \`${patron}\` no matchea NINGUNO de los ${specs.length} specs del repo. ` +
             'REAL-C3 (una regla CRITICAL) está declarada y no puede disparar nunca: se lee como "salió limpio". ' +
             'O el patrón quedó viejo, o la costura de desarrollo que vigilaba ya no se usa — en el segundo caso, sacá la llave.',
  }];
}

/** ── (3) la cobertura que se achica ─────────────────────────────────────────────────────────── */
function lintExclusionesQueCrecen(txtCarpeta, txtCommiteado) {
  if (txtCommiteado == null) return [];
  const antes = new Set(lista(txtCommiteado, 'e2e_realness', 'business_endpoint_excludes'));
  const ahora = lista(txtCarpeta, 'e2e_realness', 'business_endpoint_excludes');
  const nuevas = ahora.filter((x) => !antes.has(x));
  if (!nuevas.length) return [];
  return [{
    tipo: 'cobertura-que-baja', llave: 'e2e_realness.business_endpoint_excludes',
    mensaje: `${nuevas.length} exclusión(es) nueva(s) respecto de lo commiteado: ${nuevas.map((n) => `\`${n}\``).join(', ')}. ` +
             'Cada entrada AFLOJA dos reglas CRITICAL (REAL-C2 y REAL-C7): una intercepción de ese endpoint deja de ser un hallazgo. ' +
             'No es un cambio de config cualquiera — es una decisión de bajar cobertura. Que quede dicha en el commit.',
  }];
}

/** ── (4) un paquete que el repo nombra y no está instalado ──────────────────────── */
function lintPaquetes(txt, opts = {}) {
  const packs = require('./packs.js');
  let declarados;
  try {
    declarados = packs.paquetesDeclarados(txt);
  } catch (e) {
    if (!(e instanceof packs.PacksDeclaradosError)) throw e;
    // `packs:` sin lista (nula, `~`, sólo comentarios): no es «ninguno» ni «todos». `pipeline.js advisors` FRENA.
    return [{ tipo: 'packs-sin-lista', llave: 'packs', mensaje: `${e.message}. Con esa clave \`pipeline.js advisors\` FRENA.` }];
  }
  if (!declarados || !declarados.length) return [];
  declarados = declarados.map((n) => packs.nombreActual(n));   // un nombre viejo de paquete sigue andando
  // La carpeta por defecto ausente es «ninguno instalado» (máquina sin paquetes); sólo una
  // TYCON_PACKS_DIR explícita inexistente es «no se pudo leer». `opts` es para las pruebas.
  const dir = opts.packsDir || packs.dirPaquetes();
  const explicito = opts.explicito != null ? !!opts.explicito : !!process.env.TYCON_PACKS_DIR;
  let instalados;
  try {
    instalados = packs.nombresInstalados({ packsDir: dir, explicito });
  } catch (e) {
    // No se pudo MIRAR la carpeta: no es lo mismo que «no instalado», y se dice distinto.
    return [{
      tipo: 'paquetes-ilegibles', llave: 'packs',
      mensaje: `\`packs:\` declara ${declarados.map((n) => `\`${n}\``).join(', ')} pero no se pudo leer la carpeta de paquetes ${dir} ` +
               `(${String(e.message).split('\n').pop().trim()}). Con esa lista \`pipeline.js advisors\` FRENA. No es «no instalado»: es que no se pudo mirar.`,
    }];
  }
  const faltan = declarados.filter((n) => !instalados.includes(n));
  if (!faltan.length) return [];
  return [{
    tipo: 'paquete-inexistente', llave: 'packs',
    mensaje: `\`packs:\` nombra ${faltan.map((n) => `\`${n}\``).join(', ')} y no está instalado en ${dir} ` +
             `(instalados: ${instalados.join(', ') || 'ninguno'}). Con esa lista \`pipeline.js advisors\` FRENA: ` +
             'un paquete que falta no degrada a «sin ese paquete». O se instala (agent-skills al día, o TYCON_PACKS_DIR), o se saca de la lista.',
  }];
}

/**
 * Todo junto. `txtCommiteado` opcional (sin él, el chequeo (3) no corre).
 * @returns {{hallazgos: Array, ok: boolean}}
 */
function lintConfig({ repoRoot, txtCarpeta, txtCommiteado }) {
  if (txtCarpeta == null) return { hallazgos: [], ok: true, sinConfig: true };
  const hallazgos = [
    ...lintEsquema(txtCarpeta),
    ...lintSeamMuerta(txtCarpeta, repoRoot),
    ...lintExclusionesQueCrecen(txtCarpeta, txtCommiteado),
    ...lintPaquetes(txtCarpeta),
  ];
  return { hallazgos, ok: hallazgos.length === 0 };
}

module.exports = { ESQUEMA, claves, lista, escalar, lintEsquema, lintSeamMuerta, lintExclusionesQueCrecen, lintPaquetes, lintConfig, specsE2e, llavesSinRegistrar, archivosQueLeenLaConfig, NO_SON_DE_LA_CONFIG };
