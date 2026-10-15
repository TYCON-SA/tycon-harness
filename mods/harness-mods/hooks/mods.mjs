// Los mods del arnés y el comando /mods (story 7.27). Puro: recibe el estado y devuelve el nuevo, para probarlo con
// node (scripts/tests/harness-mods.test.js); register.tsx guarda `off` en el store del plugin (entre sesiones) y
// `hidden` en el estado de la sesión.
//
// Un mod nuevo se suma a CATALOG. Llega prendido: sólo está apagado lo que el dev apagó.

export const CATALOG = [
  { id: 'pipeline-board', description: 'el renglón con el estado de la corrida del pipeline, arriba del cuadro donde escribís, y /pipeline' },
];

const USAGE = [
  'Uso:',
  '- `/mods` — esta lista',
  '- `/mods hide <mod>` — lo oculta en esta sesión',
  '- `/mods show <mod>` — lo vuelve a mostrar en esta sesión',
  '- `/mods off <mod>` — lo apaga en esta sesión y en las siguientes',
  '- `/mods on <mod>` — lo vuelve a prender',
  '',
  'En lugar de `<mod>` va el nombre de la lista, por ejemplo: `/mods hide pipeline-board`.',
].join('\n');

const list = (xs) => (Array.isArray(xs) ? xs.filter((x) => typeof x === 'string') : []);

/** ¿El mod trabaja? (apagado = no lee ni refresca nada). */
export function isActive(id, state) {
  return !list(state && state.off).includes(id);
}

/** ¿El mod se dibuja en esta sesión? */
export function isShown(id, state) {
  return isActive(id, state) && !list(state && state.hidden).includes(id);
}

/** El estado de un mod, como lo lee el dev. */
export function modState(id, state) {
  if (!isActive(id, state)) return 'apagado';
  return isShown(id, state) ? 'visible' : 'oculto en esta sesión';
}

function listing(state) {
  const rows = CATALOG.map((m) => `- **${m.id}** — ${m.description} · ${modState(m.id, state)}`);
  return ['Mods del arnés:', ...rows, '', USAGE].join('\n');
}

/**
 * Corre `/mods <args>`. Devuelve `{ text, off, hidden, changed }`: `off` y `hidden` son el estado nuevo (iguales al de
 * entrada si no cambió nada).
 */
export function runModsCommand(args, state) {
  const off = list(state && state.off);
  const hidden = list(state && state.hidden);
  const same = (text) => ({ text, off, hidden, changed: false });
  const words = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return same(listing({ off, hidden }));

  const [verb, id, ...rest] = words;
  const known = CATALOG.some((m) => m.id === id);
  if (!['hide', 'show', 'off', 'on'].includes(verb) || !known || rest.length) {
    return same(`No entendí «${words.join(' ')}».\n\n${listing({ off, hidden })}`);
  }
  const without = (xs) => xs.filter((x) => x !== id);
  const withIt = (xs) => (xs.includes(id) ? xs : [...xs, id]);
  let next = { off, hidden };
  let done;
  if (verb === 'hide') { next = { off, hidden: withIt(hidden) }; done = `${id} queda oculto en esta sesión. Para verlo de nuevo: \`/mods show ${id}\`.`; }
  if (verb === 'show') { next = { off, hidden: without(hidden) }; done = isActive(id, next) ? `${id} se ve de nuevo.` : `${id} está apagado: para verlo, \`/mods on ${id}\`.`; }
  if (verb === 'off') { next = { off: withIt(off), hidden }; done = `${id} queda apagado, en esta sesión y en las siguientes. Para prenderlo: \`/mods on ${id}\`.`; }
  if (verb === 'on') { next = { off: without(off), hidden: without(hidden) }; done = `${id} queda prendido.`; }
  const changed = JSON.stringify(next.off) !== JSON.stringify(off) || JSON.stringify(next.hidden) !== JSON.stringify(hidden);
  return { text: done, off: next.off, hidden: next.hidden, changed };
}
