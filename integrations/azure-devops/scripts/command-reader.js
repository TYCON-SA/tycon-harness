'use strict';
/**
 * integrations/azure-devops/scripts/command-reader.js — cómo leer un comando `az repos pr …` sin dejarse engañar.
 *
 * El lector de comandos del conector de Azure DevOps: los frenos y los avisos lo piden por el programa
 * (`scripts/lib/command-readers.js` → `lectorDe('az')`), sin nombrar la plataforma. Lo genérico (las fichas, los
 * segmentos, las banderas, el escape) es de `scripts/lib/command-tokens.js` y se reexporta acá; esto agrega lo de
 * `az repos pr`: qué verbo es, qué banderas lee az y cómo, y las faltas que frenan un pedido a main.
 *
 * 🔴 Los frenos leen de acá, para que el criterio no diverja, y recorren TODOS los `pr create` de una cadena, no el
 * primero. Quien agregue un lector lo suma acá, no escribe otro regex.
 *
 * Qué NO resuelve, a propósito: sustitución de comandos (`$(…)`), heredocs, backticks. No los expande: en una bandera
 * que el freno juzga, un valor así es ilegible y es una falta (`valorDe`), y lo que se ve no puede decir
 * "auto-complete" sin tenerlo.
 */

const path = require('path');
const T = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'command-tokens.js'));
const { fichas, segmentos, flagDe, esPalabra, esCierto, esFalso, pideAyuda, textoDe, tieneEscape } = T;

/** Los programas que lee este lector (scripts/lib/command-readers.js lo busca por acá). */
const programas = ['az'];

/** Las fichas que van después del `az` del pedido (`az [globales] repos pr <verbo> …`), o el segmento entero si no lo hay. */
function delPedido(seg) {
  for (let i = 0; i < seg.length; i++) {
    if (esPalabra(seg[i]) && /(^|\/|\\)az(\.cmd|\.exe)?$/i.test(seg[i].texto) && verboDePr(seg.slice(i))) return seg.slice(i + 1);
  }
  return seg;
}

/**
 * Valor de una bandera como la lee az (argparse), mirando sólo lo que va después del `az` del pedido (`delPedido`): el
 * `-s` de `timeout -s KILL` no es el origen. Las formas y lo `literal`, en `command-tokens.js` → `valorDe`.
 */
const valorDe = (seg, nombre, corta = null) => T.valorDe(seg, nombre, corta, { desde: delPedido });


/**
 * `az [opciones globales] repos pr <verbo>` leído de las fichas sueltas: un `echo "az repos pr
 * create"` no cuenta, y `az -o json repos pr create` sí — az acepta sus opciones globales antes
 * del grupo, y exigir las cuatro palabras pegadas dejaría pasar esa forma. Una palabra citada sin espacios
 * (`esPalabra`) cuenta como suelta: para la terminal es la misma.
 * El binario puede venir con ruta, con `.cmd`/`.exe` y en cualquier caja (macOS no distingue).
 */
function verboDePr(seg) {
  const libres = seg.filter(esPalabra).map((f) => f.texto);
  for (let i = 0; i < libres.length; i++) {
    if (!/(^|\/|\\)az(\.cmd|\.exe)?$/i.test(libres[i])) continue;
    let j = i + 1;
    // saltear opciones globales (`-o json`, `--output=json`, `--only-show-errors`, …)
    while (j < libres.length && /^-/.test(libres[j])) {
      const pegado = libres[j].includes('=');
      j++;
      if (!pegado && j < libres.length && !/^-/.test(libres[j]) && libres[j] !== 'repos') j++;
    }
    if (libres[j] === 'repos' && libres[j + 1] === 'pr' && libres[j + 2]) return libres[j + 2];
  }
  return null;
}

/**
 * ¿El segmento le pasa CÓDIGO a un intérprete? (`bash -c "…"`, `sh -c`, `eval`, `python3 -c`). Ahí
 * el `az repos pr create` viaja adentro de una cadena y ninguna ficha lo delata: no se puede juzgar
 * lo que se ejecuta, así que quien llama decide (este freno lo trata como «no pude mirar» y frena).
 * Un `echo "az repos pr create"` NO entra acá: echo no ejecuta nada.
 */
function pasaCodigoAUnInterprete(seg) {
  const nombre = /(^|\/|\\)(ba|z|k|da)?sh(\.exe)?$|(^|\/|\\)python3?(\.exe)?$|^eval$|^source$/i;
  for (let i = 0; i < seg.length; i++) {
    if (!seg[i].esBandera || !nombre.test(seg[i].texto)) continue;
    if (seg.slice(i + 1).some((f) => !f.esBandera && /\baz(?:\.cmd|\.exe)?\s+(?:-\S+(?:\s+[^\s-]\S*)?\s+)*repos\s+pr\s+(?:create|update)\b/i.test(f.texto))) return true;
  }
  return false;
}

/**
 * ¿El segmento es un pedido (`repos pr create|update`) que no se puede leer? El motivo, o null. Con el programa en una
 * variable (`$AZ`, `"$AZ"`) o como `python -m azure.cli`, no se sabe qué corre; con una sustitución sin comillas
 * (`$(…)`, comillas invertidas) o el `{}` de `find -exec` adentro, sus argumentos se arman al correr: la ficha está partida.
 */
function pedidoIlegible(seg) {
  const libres = seg.filter(esPalabra).map((f) => f.texto);
  // una palabra que se arma al correr: una variable o una sustitución de comandos
  const alCorrer = (t) => /^\$[{(A-Za-z_]|`/.test(String(t || ''));
  const pedido = (desde) => libres[desde] === 'repos' && libres[desde + 1] === 'pr' && /^(create|update)$/.test(libres[desde + 2] || '');
  for (let i = 0; i < libres.length; i++) {
    if (alCorrer(libres[i]) && pedido(i + 1)) return `el programa se arma al correr (${libres[i]}): no sé qué corre`;
    // `python -m azure.cli` y el lanzador de Windows (`py -3 -m azure.cli`), también con la ruta entera
    if (/(^|[\\/])(python[0-9.]*|py)(\.exe)?$/i.test(libres[i])) {
      let j = i + 1;
      while (/^-[0-9][0-9.]*$/.test(libres[j] || '')) j++;
      if (libres[j] === '-m' && /^azure\.cli$/i.test(libres[j + 1] || '') && pedido(j + 2)) return 'az corre por python -m azure.cli: no lo leo';
    }
    // el grupo o el verbo del pedido se arma al correr: una variable o una sustitución en su lugar
    if (/(^|[\\/])az(\.cmd|\.exe)?$/i.test(libres[i]) && libres[i + 1] === 'repos'
      && (alCorrer(libres[i + 2]) || (libres[i + 2] === 'pr' && alCorrer(libres[i + 3])))) {
      return `el pedido se arma al correr (${alCorrer(libres[i + 2]) ? libres[i + 2] : libres[i + 3]}): no sé qué hace`;
    }
  }
  // el pedido sin su programa delante: el programa lo dio una sustitución o una palabra entre comillas que no leo
  for (let i = 0; i < libres.length; i++) {
    if (pedido(i) && (i === 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(libres[i - 1]))) return 'el programa se arma al correr: no sé qué corre';
  }
  const az = libres.findIndex((t) => /(^|\/|\\)az(\.cmd|\.exe)?$/i.test(t));
  // una sustitución sin comillas pegada al pedido: lo que devuelve se suma a sus argumentos (`--title $(…)`, o el
  // verbo armado con `$(echo create)`)
  if (seg.sigueSustitucion && az >= 0) {
    const tras = libres.slice(az + 1).filter((t) => !/^-/.test(t));
    if (tras[0] === 'repos' && (tras.length === 1 || (tras[1] === 'pr' && (tras.length === 2 || /^(create|update)$/.test(tras[2]))))) {
      return 'lo que devuelve una sustitución sin comillas se suma al pedido al correr: no puedo leer sus banderas';
    }
  }
  const verbo = verboDePr(seg);
  if (verbo !== 'create' && verbo !== 'update') return null;
  // detrás de xargs, lo que llega por la entrada se agrega a los argumentos al correr
  if (libres.slice(0, az).some((t) => /(^|\/)xargs$/.test(t))) return 'xargs le agrega argumentos al correr: no puedo leer sus banderas';
  const partida = seg.find((f) => f.esBandera && (/\$\(|`/.test(f.texto) || f.texto === '{}'));
  return partida ? `un argumento se arma al correr (${partida.texto}): no puedo leer sus banderas` : null;
}

/**
 * Filtro barato para descartar de una un comando que no tiene nada que ver. Mira el texto YA unido:
 * un `az repos pr \<salto> create` esquivaría el filtro y con él al hook entero. Y NO nombra al binario a
 * propósito: pedir `az` pegado a `repos` lo esquivaría
 * con `az -o json repos pr create`, que az acepta. Es un superconjunto barato — quien decide de
 * verdad es `verboDePr` sobre las fichas. Mira sin comillas ni barras: `az re"pos" 'pr' cr\eate` es el mismo comando.
 */
const pareceAzPr = (cmd) => /\brepos\s+(?:pr|\$\S+|`[^`]*`)\s+(?:create\b|update\b|\$|`)/i
  .test(String(cmd || '').replace(/\\\r?\n/g, ' ').replace(/["'\\]/g, ''));

const ROMPE_SQUASH = 'los commits desaparecen de main y las notas de versión colapsan a una línea';
const A_MAIN = /^(?:refs\/heads\/)?(?:main|master)$/i;

/**
 * Las ramas de origen que NO se borran al completar un pedido. La lista declarada es la de §9b.4 del paso de merge
 * (`skills/tycon-merge-to-main/steps/step-09b-create-change-request.md`, «Ramas de larga vida»); ésta es su copia para
 * el freno, y `scripts/tests/pr-auto-complete-guard.test.sh` falla si las dos difieren. Cualquier otra rama de origen
 * es efímera: si el pedido no la borra, queda viva después del merge y se acumula.
 */
const RAMAS_DE_LARGA_VIDA = Object.freeze(['dev', 'develop', 'main', 'master']);
// Azure DevOps no distingue mayúsculas en los nombres de rama: `-s DEV` es `dev`, y `Refs/Heads/main` es `main`. Los
// espacios de los costados no cuentan: `-s ' dev'` se compara como `dev`, así frena de más y nunca de menos.
const esDeLargaVida = (rama) => RAMAS_DE_LARGA_VIDA.includes(String(rama).trim().replace(/^refs\/heads\//i, '').toLowerCase());

const ilegible = (bandera, v) => `no puedo leer \`${bandera} ${v.texto}\`: lo arma la terminal, trae un comodín o az lo lee de un archivo, y lo que no pude leer no está aprobado. Escribí el valor`;

/**
 * La falta de un pedido que se crea sobre «borrar la rama al completar», o null. `borrar` y `origen` son lo que da
 * `valorDe`. Ningún «sin falta» sale antes de ver la rama: con `true` desde `dev`, la plataforma borraría `dev`.
 */
function faltaDeBorrarRama(borrar, origen) {
  const regla = '`true` desde una rama efímera escrita con `-s`, o `false` desde dev, develop, main o master';
  if (borrar === null) return `sin \`--delete-source-branch\` explícito: la rama queda viva después del merge. Va ${regla}`;
  if (!borrar.literal) return ilegible('--delete-source-branch', borrar);
  if (!esCierto(borrar.texto) && !esFalso(borrar.texto)) return `con \`--delete-source-branch ${borrar.texto}\`: no es un valor que entienda. Va ${regla}`;
  const cierto = esCierto(borrar.texto);
  if (origen === null) {
    return cierto
      ? 'con `--delete-source-branch true` y sin `--source-branch`: az toma la rama actual, que puede ser dev. Escribí la rama'
      : 'con `--delete-source-branch false` y sin `--source-branch`: no puedo ver si la rama es de larga vida. Escribí la rama';
  }
  if (!origen.literal) return ilegible('--source-branch', origen);
  // Un origen vacío o de sólo espacios no nombra ninguna rama: si az lo toma como «sin rama», usa la actual
  if (!origen.texto.trim()) return `no puedo leer \`--source-branch\`: viene vacío, y az puede tomar la rama actual, que puede ser dev. Escribí la rama`;
  const larga = esDeLargaVida(origen.texto);
  if (cierto && larga) return `con \`--delete-source-branch true\` desde \`${origen.texto}\`: la plataforma borraría \`${origen.texto}\` al completar, sin vuelta atrás. Desde una rama de larga vida va \`false\``;
  if (!cierto && !larga) return `con \`--delete-source-branch false\` desde \`${origen.texto}\`: la rama queda viva después del merge. Va ${regla}`;
  return null;
}

/**
 * Lo mismo para un `update`, que no dice la rama de origen (az no acepta `--source-branch` ahí). Con la rama que dio la
 * plataforma (`origen`, lib/pr-source-branch.js) vale la regla de crear: `true` desde una rama efímera, `false` desde una
 * de larga vida. Sin ella, `true` no se puede juzgar (podría borrar `dev`) y frena, y `false` pasa.
 */
function faltaDeBorrarRamaUpdate(borrar, publica, origen = null) {
  const regla = origen
    ? (esDeLargaVida(origen) ? `el pedido sale de \`${origen}\`, una rama de larga vida: va \`--delete-source-branch false\`` : `el pedido sale de \`${origen}\`: va \`--delete-source-branch true\` (la rama se borra al entrar)`)
    : 'va `--delete-source-branch false`: no pude leer la rama del pedido, así que `true` no lo puedo juzgar. Si no, el skill de merge, o el escape';
  if (borrar === null) return publica ? `publica un borrador sin \`--delete-source-branch\` explícito: ${regla}` : null;
  if (!borrar.literal) return ilegible('--delete-source-branch', borrar);
  if (!esCierto(borrar.texto) && !esFalso(borrar.texto)) return `con \`--delete-source-branch ${borrar.texto}\`: no es un valor que entienda; ${regla}`;
  const cierto = esCierto(borrar.texto);
  if (!origen) return cierto ? `con \`--delete-source-branch true\`: ${regla}` : null;
  const larga = esDeLargaVida(origen);
  if (cierto && larga) return `con \`--delete-source-branch true\`: la plataforma borraría \`${origen}\` al completar, sin vuelta atrás; ${regla}`;
  if (!cierto && !larga) return `con \`--delete-source-branch false\`: la rama queda viva después del merge; ${regla}`;
  return null;
}

/**
 * ¿El `update` puede completar el pedido? Con el auto-completar prendido, `--status completed` o saltando las políticas.
 * Al completarse, la plataforma aplica la opción de borrar la rama que el pedido ya tenía, aunque el comando no la nombre.
 */
function puedeCompletar(seg) {
  const literal = (nombre) => { const x = valorDe(seg, nombre); return x && x.literal ? x.texto : null; };
  return esCierto(literal('auto-complete')) || String(literal('status') || '').toLowerCase() === 'completed' || esCierto(literal('bypass-policy'));
}

/**
 * ¿Juzgar este pedido pide la rama de origen? Un `update` con `--delete-source-branch` escrito, o uno sin ella que puede
 * completar el pedido. Lo usan el freno (para preguntarla) y la revisión nocturna, que no la tiene y entonces no puede
 * decir que el escape sobraba.
 */
function necesitaLaRama(seg) {
  if (verboDePr(seg) !== 'update') return false;
  const borrar = valorDe(seg, 'delete-source-branch');
  return borrar ? borrar.literal : puedeCompletar(seg);
}

/**
 * Una ficha del pedido con una expansión fuera de comillas: la terminal la parte en palabras y puede meter una bandera.
 * Lo de antes del `az` no cuenta: el lado derecho de `VAR=$X az …` no se parte.
 */
const partidas = (seg) => delPedido(seg).filter((f) => f.partida).map((f) => `\`${f.texto}\` lo arma la terminal fuera de comillas: puede meter una bandera que no veo, y lo que no pude leer no está aprobado. Ponelo entre comillas o escribí el valor`)
  .concat(fantasmas(seg));

// Las banderas de un pedido que exigen exactamente un valor: si la terminal convierte ese valor en otra bandera,
// az falla en vez de correr. Es la única excepción y es una lista cerrada; abreviadas, con `=` o con el valor pegado no
// cuentan. Detrás de cualquier otra (sin valor como `--open`, opcional como `--draft`, de varios como `--description`)
// una expansión puede ser la bandera siguiente.
const VALOR_UNICO = new Set(['--title', '--source-branch', '--target-branch', '--repository', '--project', '--organization',
  '--org', '--id', '--merge-commit-message', '--output', '--query', '--subscription', '-s', '-t', '-r', '-p', '-o']);

/**
 * Una expansión, aunque esté entre comillas, puesta donde az espera una bandera: `"$F" dev` o `"--delete-source-$X" true`
 * puede ser cualquier bandera, y lo que no se lee no está aprobado. Sólo se salva el valor de una bandera de
 * `VALOR_UNICO` escrita entera (`--title "$T"`).
 */
function fantasmas(seg) {
  const pedido = delPedido(seg);
  const out = [];
  pedido.forEach((f, i) => {
    // Sólo si la expansión puede cambiar el NOMBRE: `--title=x"$T"` o `-s"$X"` tienen la bandera escrita.
    if (!f.expande || f.partida || !/^(?:[$`]|-[$`]|--[^=]*[$`])/.test(f.texto)) return;
    const prev = pedido[i - 1];
    // El destino de una redirección (`2> "$LOG"`, `>> "$OUT"`) es un archivo, no una bandera para az
    if (prev && prev.esBandera && !prev.escapada && /^\d*(?:>>?|<|&>>?|>\|)$/.test(prev.texto)) return;
    if (prev && !prev.expande && VALOR_UNICO.has(prev.texto)) return;
    // La forma del skill de merge, `--description "$(cat cuerpo.md)"` (AC 1), y sólo ésa: az la lee como bandera sólo si
    // el cuerpo empieza con un guion, y el cuerpo lo escribe el skill. `-d`, otro comando o una variable siguen frenando.
    if (prev && !prev.expande && prev.texto === '--description' && /^\$\(cat\s/.test(f.texto)) return;
    out.push(`no puedo leer \`${f.texto}\`: una expansión donde va una bandera puede ser cualquier bandera, y lo que no pude leer no está aprobado. Escribí la bandera`);
  });
  return out;
}

/**
 * La regla del freno de pedidos sobre UN segmento, sin mirar el escape: `{ verbo, juzgado, borrador, faltas }`.
 * `juzgado: false` es un segmento que la regla no mira (otro verbo, un pedido que no va a main, un borrador recién
 * creado: `borrador: true`). Un segmento juzgado sin `faltas` cumple la regla. La usan el freno (que agrega el escape,
 * el pedido de ayuda y el código pasado a un intérprete) y la revisión nocturna de las ejecuciones, que con ella sabe
 * si un pedido armado con el escape lo necesitaba.
 */
function faltasDe(seg, { ramaDeOrigen = null } = {}) {
  const verbo = verboDePr(seg);
  const res = { verbo, juzgado: false, borrador: false, faltas: [] };
  if (verbo !== 'create' && verbo !== 'update') return res;
  // Lo que se juzga se lee como lo lee az, y lo que no se puede leer es una falta (`valorDe`).
  const v = {
    autoComplete: valorDe(seg, 'auto-complete'), squash: valorDe(seg, 'squash'), draft: valorDe(seg, 'draft'),
    destino: valorDe(seg, 'target-branch', 't'), borrar: valorDe(seg, 'delete-source-branch'),
  };
  const ilegibles = [['--auto-complete', v.autoComplete], ['--squash', v.squash], ['--draft', v.draft], ['--target-branch', v.destino]]
    .filter(([, x]) => x && !x.literal).map(([b, x]) => ilegible(b, x));
  const autoComplete = v.autoComplete && v.autoComplete.literal ? v.autoComplete.texto : null;
  const squash = v.squash && v.squash.literal ? v.squash.texto : null;
  const draft = v.draft && v.draft.literal ? v.draft.texto : null;
  if (verbo === 'create') {
    // Sólo los que van a main: el skill es el camino de esa rama. Un destino ilegible puede ser main.
    // Una ficha partida va antes que todo: puede meter `--target-branch main` o `--draft false` detrás de lo que se ve,
    // y en az gana la última.
    const partes = partidas(seg);
    if (partes.length) { res.juzgado = true; res.faltas.push(...partes); }
    if (!partes.length && v.destino && v.destino.literal && !A_MAIN.test(v.destino.texto)) return res;
    if (!partes.length && esCierto(draft)) { res.borrador = true; return res; }
    res.juzgado = true;
    res.faltas.push(...ilegibles);
    if (v.autoComplete && !v.autoComplete.literal) return res;
    if (!esCierto(autoComplete)) res.faltas.push('sin `--auto-complete true`: el PR queda abierto para siempre, nadie lo completa');
    if (v.squash === null) res.faltas.push(`sin \`--squash false\` explícito: la estrategia la decide la política de la rama, y si es squash ${ROMPE_SQUASH}`);
    else if (v.squash.literal && !esFalso(squash)) res.faltas.push(`con \`--squash ${squash}\`: ${ROMPE_SQUASH}`);
    // Sólo con auto-completar: sin él ya hay una falta, y la rama no se borra porque el pedido no se completa solo.
    if (esCierto(autoComplete)) {
      const falta = faltaDeBorrarRama(v.borrar, valorDe(seg, 'source-branch', 's'));
      if (falta) res.faltas.push(falta);
    }
    return res;
  }
  res.juzgado = true;
  // Una ficha partida es falta en todo `update`: puede meter `--delete-source-branch true` que no se ve.
  res.faltas.push(...ilegibles, ...partidas(seg));
  if (esFalso(autoComplete)) res.faltas.push('apaga el auto-complete de un PR ya creado: queda abierto para siempre');
  if (esCierto(squash)) res.faltas.push(`prende el squash de un PR ya creado: ${ROMPE_SQUASH}`);
  // Publicar un borrador es CREARLO de verdad: la tercera puerta al mismo resultado.
  const publica = esFalso(draft);
  if (publica) {
    if (!esCierto(autoComplete)) res.faltas.push('publica un borrador (`--draft false`) sin `--auto-complete true`: queda un PR normal que nadie completa');
    if (squash === null || !esFalso(squash)) res.faltas.push('publica un borrador sin `--squash false` explícito: la estrategia la decide la política de la rama');
  }
  // El borrador se creó sin que el freno lo juzgara: publicar pide la bandera, juzgada con la rama del pedido si quien
  // llama la leyó (`ramaDeOrigen`). Un `update` común sin la bandera no se mira: az conserva la opción que el pedido ya
  // tenía (`update_pull_request` parte de `existing_pr.completion_options`).
  const falta = faltaDeBorrarRamaUpdate(v.borrar, publica && esCierto(autoComplete), ramaDeOrigen);
  if (falta) res.faltas.push(falta);
  // Sin la bandera, un update que puede completar el pedido aplica la opción que el pedido ya tenía. Si sale de una rama
  // de larga vida, `false` tiene que ir escrito: un pedido creado por otro camino puede traer «borrar la rama». Sin la
  // rama leída no se juzga, como antes.
  else if (v.borrar === null && ramaDeOrigen && esDeLargaVida(ramaDeOrigen) && puedeCompletar(seg)) {
    res.faltas.push(`puede completar un pedido que sale de \`${ramaDeOrigen}\`, una rama de larga vida, sin \`--delete-source-branch\` escrito: si el pedido ya traía «borrar la rama al completar», la plataforma borraría \`${ramaDeOrigen}\`. Va \`--delete-source-branch false\``);
  }
  return res;
}

module.exports = { programas, fichas, pareceAzPr, segmentos, flagDe, valorDe, esCierto, esFalso, verboDePr, pasaCodigoAUnInterprete, pedidoIlegible, pideAyuda, textoDe, tieneEscape, faltasDe, puedeCompletar, necesitaLaRama, ROMPE_SQUASH, RAMAS_DE_LARGA_VIDA };
