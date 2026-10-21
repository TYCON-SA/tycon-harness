#!/usr/bin/env node
'use strict';
/**
 * Paridad de las copias de `release-notes.sh` — por COMPORTAMIENTO, no por texto.
 *
 * 🔴 POR QUÉ EXISTE
 *
 * `scripts/release-notes.sh` está COPIADO en 8 repos del equipo. Nada las mantiene iguales: editar
 * las ocho a mano es lento y se desparejan. Si una copia no filtra `^Merged PR`, su próxima versión
 * publica "Merged PR <id>: …" al administrador que instala el plugin. Un filtro escrito ANTES de que
 * existiera el flujo con Pull Request queda sin revisar cuando el flujo cambia.
 *
 * Comparar los archivos byte a byte NO sirve: las copias difieren legítimamente (la variante de
 * formularios tiene lógica propia) y difieren en comentarios. Lo que TIENE que ser igual es lo
 * que el filtro HACE. Así que este control no compara texto: extrae el filtro de ruido de cada
 * copia y le pasa un corpus fijo de mensajes de commit por `grep -E` —el motor real, no una
 * reimplementación— y compara los veredictos.
 *
 * Falla hacia el ruido: si una copia no se puede leer, se DICE. Un archivo ilegible no es un
 * archivo que pasa.
 *
 * Uso:   node scripts/tools/release-notes-parity.js [--root <dir>] [--json]
 * Sale 1 si hay divergencia o si alguna copia no se pudo leer.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Corpus: cada entrada es [mensaje, esperado]. `true` = tiene que quedar FILTRADO (es ruido).
// Las que dicen `false` son cambios reales del producto y NO pueden desaparecer de la nota.
const CORPUS = [
  ['chore: bump version to 1.2.3 [skip ci]', true],
  ['chore: trigger CI pipeline post-merge', true],
  ['chore(ci): quitar release/* del disparador', true],
  ['Merged PR 2597: Story 5.4 — spec', true],
  // Los demás asuntos con que un merge llega a main, censados en los repos reales de seis productos.
  // El filtro no puede exigir dos puntos después del número: dejaría pasar «Merge PR #<id> into main»
  // (sin los dos puntos), que existe de verdad.
  ['Merge pull request 3137 from dev into main', true],
  ['Merge PR #2380: Story 3.1 — alta de artículos', true],
  ['Merge PR #1918 into main', true],
  ['Merge PR 1918 into main', true],
  ['Merge PR: Acme Backend — catálogo W-123', true],
  ["Merge branch 'dev' into main", true],
  // Control: un cambio REAL que habla de un merge no empieza con esas fórmulas y no se filtra.
  ['fix: el merge de listas perdía el último elemento', false],
  ['ci: el porton del arnes, donde viven las stories', true],
  ['fix(ci): el porton no podia actualizar la rama destino', true],
  ['chore: update versions and add deployment ZIPs [skip ci]', true],
  ['feat(pedidos): listado con filtro por fecha', false],
  ['fix(vencimientos): la fecha se calculaba mal', false],
  ['feat: alta de entregas', false],
  ['fix: el total no coincidia con las filas', false],
  ['perf(listado): la consulta baja de 4s a 300ms', false],
];

function copias(root) {
  const out = [];
  for (const prod of fs.readdirSync(root, { withFileTypes: true })) {
    if (!prod.isDirectory()) continue;
    const pd = path.join(root, prod.name);
    let hijos;
    try { hijos = fs.readdirSync(pd, { withFileTypes: true }); } catch { continue; }
    for (const repo of hijos) {
      if (!repo.isDirectory()) continue;
      const f = path.join(pd, repo.name, 'scripts', 'release-notes.sh');
      if (fs.existsSync(f)) out.push({ nombre: `${prod.name}/${repo.name}`, archivo: f });
    }
  }
  return out.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

function filtroDe(archivo) {
  const s = fs.readFileSync(archivo, 'utf8');
  const m = s.match(/^RUIDO='([^']*)'/m);
  if (!m) throw new Error('no declara RUIDO=');
  return m[1];
}

/**
 * ¿El CAMINO DE RESPALDO también filtra el ruido?
 *
 * 🔴 POR QUÉ SE COMPRUEBA
 *
 * El guion tiene dos caminos: la lista normal desde un punto de partida, y un respaldo para
 * cuando ese punto no es confiable. El respaldo publica el último commit TAL CUAL — y con el
 * flujo de Pull Request ese commit se llama "Merged PR N: …". Un filtro que sólo se aplica en el
 * camino normal, donde los merges ya están excluidos por otra vía, no sirve ahí: el único camino que
 * lo necesita no lo usa.
 *
 * Un detector que compara una sola línea —la del filtro— daría VERDE, porque las copias rotas
 * la tienen igual que las sanas, y se publicaría "Merged PR <id>: …" al administrador que instala
 * el plugin con el control en verde.
 *
 * La lección, que vale para cualquier control de este tipo: **comparar UNA señal no es comparar
 * el comportamiento**. Un control que mira al lado del problema es peor que no tenerlo, porque
 * ocupa el lugar del que sí lo miraría.
 */
function respaldoFiltra(archivo) {
  const s = fs.readFileSync(archivo, 'utf8');
  const m = s.match(/^\s*ULTIMO=\$\((.*)$/m);
  // 🔴 "No encontré la línea" NO es "esta copia no tiene camino de respaldo". Devolver `null` acá le daría
  // pase libre a una copia cuya línea estuviera escrita apenas distinta —partida en dos renglones, con
  // `local`, con otras comillas—: el detector la dejaría pasar sin decir una palabra. Es EXACTAMENTE el
  // error que este detector existe para evitar —comparar una sola forma— un nivel más abajo. Por eso se
  // dice, y cae en la rama de "no se pudo leer", que sale por el canal de errores.
  if (!m) throw new Error('no se pudo leer su camino de respaldo (no encontré la línea ULTIMO=)');
  return /grep\s+-vE\s+"?\$RUIDO/.test(m[1]);
}

// El motor REAL: grep -E, el mismo que usa el guion. No se reimplementa la expresión en JS.
function filtra(patron, mensaje) {
  try {
    execFileSync('grep', ['-qE', patron], { input: mensaje, stdio: ['pipe', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}

function main() {
  const argv = process.argv.slice(2);
  const explicita = argv.includes('--root');
  const json = argv.includes('--json');
  let root;
  if (explicita) root = argv[argv.indexOf('--root') + 1];
  else {
    // La raíz la resuelve el arnés: nunca una carpeta escrita a mano. Sin raíz no hay copias que
    // comparar, y se DICE: «no medido» no es «todo alineado». Un ~/.claude/tycon.json roto tira: un comando frena.
    const r = require('../lib/repos-root.js').resolveReposRoot();
    if (!r.root) { console.log(`release-notes-parity: no medido — sin raíz de repos en esta máquina (${r.motivo}); no hay copias que comparar.`); return 0; }
    root = r.root;
  }

  // 🔴 Una raíz que NO existe se trata distinto según quién la eligió, y la diferencia importa:
  //   · la pasó una persona  → es un error suyo, y callarse es el modo de falla de
  //     un `ls` a la carpeta equivocada leído como "acá no hay nada". Sale 1.
  //   · la dedujo el arnés    → esta máquina simplemente no tiene ese árbol de repos. Sale 0,
  //     pero DICIÉNDOLO: un silencio acá se lee como "todo alineado".
  if (!fs.existsSync(root)) {
    if (explicita) { console.error(`❌ release-notes-parity: la raíz ${root} no existe — no se revisó nada, y eso NO es "todo bien".`); return 1; }
    console.log(`release-notes-parity: no existe ${root} en esta máquina — no hay copias que comparar.`);
    return 0;
  }

  const cs = copias(root);
  // El CANÓNICO entra en la comparación: mientras las 8 copias existan, lo que
  // importa es que TODAS —incluida la fuente— clasifiquen igual. Si el canónico se rompe, este
  // control tiene que gritar antes de que la rotura se propague.
  const canonico = path.join(__dirname, '..', 'ci', 'release-notes.sh');
  if (fs.existsSync(canonico)) cs.unshift({ nombre: '⭐ CANÓNICO (arnés)', archivo: canonico });

  if (!cs.length) {
    console.log(`release-notes-parity: no encontré ninguna copia de release-notes.sh bajo ${root} — nada que comparar.`);
    return 0;
  }

  const filas = [];
  let ilegibles = 0;
  for (const c of cs) {
    try {
      const patron = filtroDe(c.archivo);
      const veredictos = CORPUS.map(([msg]) => filtra(patron, msg));
      filas.push({ ...c, patron, veredictos, respaldo: respaldoFiltra(c.archivo) });
    } catch (e) {
      ilegibles++;
      filas.push({ ...c, error: e.message });
    }
  }

  // Divergencias: contra lo ESPERADO del corpus, no contra la mayoría — una mayoría equivocada
  // (siete copias mal y una bien) se daría a sí misma por buena.
  const fallas = [];
  for (const f of filas) {
    if (f.error) { fallas.push({ repo: f.nombre, motivo: `no se pudo leer: ${f.error}` }); continue; }
    // El camino de RESPALDO tiene que filtrar igual que el normal. `null` = la copia no tiene ese
    // camino, y ahí no hay nada que comparar.
    if (f.respaldo === false) {
      fallas.push({
        repo: f.nombre,
        motivo: 'el camino de respaldo publica el último commit SIN FILTRAR — con el flujo de '
          + 'Pull Request eso le publica "Merged PR N: …" a quien instala el plugin',
      });
    }
    CORPUS.forEach(([msg, esperado], i) => {
      if (f.veredictos[i] !== esperado) {
        fallas.push({
          repo: f.nombre,
          motivo: esperado
            ? `deja pasar ruido a la nota de versión: "${msg}"`
            : `🔴 BORRA un cambio real de la nota: "${msg}"`,
        });
      }
    });
  }

  // ── Los OTROS DOS guiones copiados ────────────────────────────────────────────
  // No es un guion duplicado: son TRES. `inject-release-notes.sh` (4 backends) y
  // `recompute-zip-notes.sh` (4 frontends) son copias sin nadie que las vigile: sin esto
  // se partirían en variantes sin que nadie se entere. Acá se comparan por
  // CONTENIDO contra el canónico —tienen que ser idénticos, no sólo parecidos— ignorando
  // comentarios y líneas en blanco, que es lo único que puede diferir legítimamente.
  // el canónico del arnés lleva el nombre en inglés y en su ruta vieja queda un
  // reemplazo que no es el código; la copia de un producto sigue con el nombre de siempre hasta que el
  // producto la cambie. Se busca con los dos nombres, y el viejo sale del mapa de renombres (sin el mapa,
  // sólo el nuevo).
  const otros = ['inject-release-notes.sh', 'recompute-zip-notes.sh'];
  const nombresDeCopia = (nombre) => {
    try {
      const ln = require('../lib/legacy-names.js');
      const viejos = [...ln.basenameRenames(ln.loadMap())].filter(([, nuevo]) => nuevo === nombre).map(([viejo]) => viejo);
      return [nombre, ...viejos];
    } catch { return [nombre]; }
  };
  const codigo = (f) => fs.readFileSync(f, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).join('\n');
  for (const nombre of otros) {
    const can = path.join(__dirname, '..', 'ci', nombre);
    if (!fs.existsSync(can)) { fallas.push({ repo: `⭐ ${nombre}`, motivo: 'falta el canónico en el arnés' }); continue; }
    const ref = codigo(can);
    for (const prod of fs.readdirSync(root, { withFileTypes: true })) {
      if (!prod.isDirectory()) continue;
      let hijos; try { hijos = fs.readdirSync(path.join(root, prod.name), { withFileTypes: true }); } catch { continue; }
      for (const repo of hijos) {
        if (!repo.isDirectory()) continue;
        for (const copia of nombresDeCopia(nombre)) {
          const f = path.join(root, prod.name, repo.name, 'scripts', copia);
          if (!fs.existsSync(f)) continue;
          filas.push({ nombre: `${prod.name}/${repo.name} · ${copia}`, archivo: f, copia: true });
          try {
            if (codigo(f) !== ref) fallas.push({ repo: `${prod.name}/${repo.name}`, motivo: `su copia de ${copia} DIVERGE del canónico del arnés` });
          } catch (e) { fallas.push({ repo: `${prod.name}/${repo.name}`, motivo: `no se pudo leer ${copia}: ${e.message}` }); }
        }
      }
    }
  }

  if (json) { console.log(JSON.stringify({ copias: filas.length, fallas }, null, 1)); return fallas.length ? 1 : 0; }

  console.log(`release-notes-parity: ${filas.length} archivo(s) vigilado(s) bajo ${root} (los TRES guiones)`);
  for (const f of filas) console.log(`   · ${f.nombre}${f.error ? '  ❌ ' + f.error : ''}`);
  if (!fallas.length) {
    console.log(`\n✅ los ${filas.length} coinciden: el filtro de ruido clasifica igual los ${CORPUS.length} casos del corpus, y las copias de los otros dos guiones son idénticas al canónico.`);
    return 0;
  }
  console.error(`\n❌ ${fallas.length} divergencia(s) — el ruido de CI y los merges NO puede llegar a la nota que lee quien instala el plugin:`);
  for (const x of fallas) console.error(`   · ${x.repo}: ${x.motivo}`);
  console.error(`\n   Arreglo: alinear con el resto el RUIDO='…' Y el camino de respaldo (ULTIMO=…) de esa copia.`);
  return 1;
}

// 🔴 `process.exitCode`, NO `process.exit()`: en Node las escrituras a una tubería son
// ASINCRÓNICAS y `process.exit()` mata el proceso con parte de lo escrito en el aire. Medido con
// la forma de este guión (una escritura grande y salir): a 41 KB llega cortado en 8192 y el JSON
// se rompe; el consumidor lo lee como «no pude», nunca como un error.
if (require.main === module) process.exitCode = main();
module.exports = { CORPUS, filtroDe, filtra, copias, respaldoFiltra };
