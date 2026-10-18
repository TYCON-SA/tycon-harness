// Los mods del arnés (story 7.27): el cartel de la corrida del pipeline arriba del prompt, /pipeline y /mods.
//
// La lógica vive en módulos puros (run.mjs, mods.mjs, steps.mjs) que prueba scripts/tests/harness-mods.test.js con
// node; acá sólo se engancha al motor. Sin dinero: el dueño lo sacó del cartel.
//
// Estado: `hidden` y `snapshot` son de la sesión; `off` se guarda en el store del plugin (entre sesiones) y se copia
// a la sesión al arrancar. Un mod apagado no lee nada ni registra su reloj.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snapshot } from '../types'
import { readRun, boardParts, storyPathOf, specTitle, pipelineTable, warnKey, waitingToast, stickyWaiting, addWarned, stateDirs, NO_RUN_TEXT } from './run.mjs'
import { runModsCommand, isActive, isShown } from './mods.mjs'

const BOARD = 'pipeline-board'
const EVERY_MS = 30000
const OFF_TEXT = `${BOARD} está apagado: para verlo, \`/mods on ${BOARD}\`.`

const snapshot = atom({ plugin: 'harness-mods', key: 'snapshot' } as const, null as Snapshot | null)
const hidden = atom({ plugin: 'harness-mods', key: 'hidden' } as const, [] as string[])
const off = atom({ plugin: 'harness-mods', key: 'off' } as const, [] as string[])
const warned = atom({ plugin: 'harness-mods', key: 'warned' } as const, [] as string[])
const waitingFor = atom({ plugin: 'harness-mods', key: 'waitingFor' } as const, null as string | null)

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/**
 * El marker de la sesión, en la primera carpeta del estado que lo tenga (como tycon-home.js). `text: null` sin
 * marker; `error` si el archivo está pero no se pudo leer (eso no es «sin corrida»: /pipeline lo dice).
 */
async function markerText($: any): Promise<{ text: string | null; error: string | null }> {
  const id = await $.session.id()
  const dirs = stateDirs({ HOME: await $.env.get('HOME'), USERPROFILE: await $.env.get('USERPROFILE'), TYCON_HOME: await $.env.get('TYCON_HOME') })
  for (const dir of dirs) {
    const file = `${dir}/active/${id}.json`
    if (!(await $.fs.exists(file))) continue
    try {
      return { text: await $.fs.read(file), error: null }
    } catch (e: any) {
      return { text: null, error: `${file} (${e?.message || e})` }
    }
  }
  return { text: null, error: null }
}

// el título de cada story leída: la spec no se vuelve a leer en cada refresco (una recarga del módulo la olvida)
const titles = new Map<string, string | null>()

/** El título de la story desde el frontmatter de su spec; `null` si no hay ruta o no se pudo leer. */
async function titleFromSpec($: any, markerTextValue: string | null): Promise<string | null> {
  const file = markerTextValue ? storyPathOf(markerTextValue) : null
  if (!file) return null
  if (titles.has(file)) return titles.get(file) ?? null
  // sin la spec el cartel sigue con el número solo; se recuerda sólo lo leído, para volver a probar si aparece
  try {
    if (!(await $.fs.exists(file))) return null
    const title = specTitle(await $.fs.read(file))
    titles.set(file, title)
    return title
  } catch (_) {
    return null
  }
}

async function refresh($: any): Promise<void> {
  // apagado: no lee nada, y no deja una foto vieja que /pipeline o el cartel muestren como actual (clase 9)
  if (!isActive(BOARD, { off: await read($, off) })) {
    await update($, snapshot, () => null)
    return
  }
  const marker = await markerText($)
  const sticky = stickyWaiting(readRun(marker.text, await $.clock.now()), await read($, waitingFor))
  await update($, waitingFor, () => sticky.remember)
  const run = sticky.run && !sticky.run.title ? { ...sticky.run, title: await titleFromSpec($, marker.text) } : sticky.run
  // el contexto es un dato más del renglón: si la sesión no lo da, se muestra «—»
  let context: number | null = null
  try {
    const usage = await $.session.usage()
    context = typeof usage?.context?.percent === 'number' ? usage.context.percent : null
  } catch (_) {
    context = null
  }
  await update($, snapshot, () => ({ run, context, readError: marker.error, error: null }))
  const key = warnKey(run, await read($, warned))
  if (key && run) {
    // se anota de una vez: dos refrescos a la par no dan dos avisos (clase 4)
    let added = false
    await update($, warned, (w) => { const r = addWarned(w, key); added = r.added; return r.list })
    if (added) $.ui.toast(waitingToast(run))
  }
}

/** `refresh` sin promesas sueltas: un error queda en la foto (/pipeline lo muestra) en vez de perderse. */
async function safeRefresh($: any): Promise<void> {
  try {
    await refresh($)
  } catch (e: any) {
    const error = String(e?.message || e)
    try { await update($, snapshot, (s) => ({ run: s?.run ?? null, context: s?.context ?? null, readError: s?.readError ?? null, error })) } catch (_) { /* sin estado no hay dónde anotarlo */ }
  }
}

// el reloj del cartel: uno solo por carga del módulo (una recarga lo descarta y `session.start` lo vuelve a poner)
// `$.clock.every` devuelve un reloj con `cancel()`, no una función (clase 8)
let timer: null | { cancel: () => void } = null

function startTimer($: any): void {
  if (!timer) timer = $.clock.every(EVERY_MS, () => { void safeRefresh($) })
}

function stopTimerNow(): void {
  if (timer) { timer.cancel(); timer = null }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pipeline', description: 'Los pasos de la corrida del pipeline de esta sesión' })
    await $.command.register({ name: 'mods', description: 'Los mods del arnés: listarlos, ocultarlos en la sesión o apagarlos' })
    // lo apagado se guarda entre sesiones; si el almacén no contesta, todo queda prendido (lo de fábrica)
    let saved: string[] = []
    try { saved = asList(await $.store.get('off')) } catch (_) { saved = [] }
    await update($, off, () => saved)
    if (isActive(BOARD, { off: saved })) {
      startTimer($)
      await safeRefresh($)
    }
    return next(e)
  })

  // el cartel nunca frena una herramienta: si algo de acá falla, la herramienta corre igual
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    void safeRefresh($)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'pipeline' }, async $ => {
    if (!isActive(BOARD, { off: await read($, off) })) return { text: OFF_TEXT }
    await safeRefresh($)
    const snap = await read($, snapshot)
    // con una corrida en la foto y una falla del último refresco, la tabla se muestra pero se dice que puede estar vieja
    if (snap && snap.run) return { text: snap.error ? `${pipelineTable(snap.run)}\n\n(Puede estar desactualizada: no pude actualizar el cartel: ${snap.error})` : pipelineTable(snap.run) }
    // un marker que está pero no se lee no es «sin corrida», y una falla del cartel tampoco: cada uno se dice así
    // (revisión de legibilidad de la pantalla)
    if (snap && snap.readError) return { text: `Hay una corrida en esta sesión, pero no pude leer su archivo: ${snap.readError}` }
    if (snap && snap.error) return { text: `No pude actualizar el cartel: ${snap.error}` }
    return { text: NO_RUN_TEXT }
  })

  on('command.run', { command: 'mods' }, async ($, e) => {
    const r = runModsCommand(e.args, { off: await read($, off), hidden: await read($, hidden) })
    if (r.changed) {
      // lo que va «para siempre» se guarda primero: si no se pudo, no se le dice al dev que quedó apagado
      if (JSON.stringify(r.off) !== JSON.stringify(await read($, off))) {
        try { await $.store.set('off', r.off) } catch (err: any) {
          return { text: `No pude guardar el cambio (${err?.message || err}): no cambió nada.` }
        }
      }
      await update($, hidden, () => r.hidden)
      await update($, off, () => r.off)
      if (isActive(BOARD, r)) { startTimer($); await safeRefresh($) } else stopTimerNow()
    }
    return { text: r.text }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    const state = { off: await read($, off), hidden: await read($, hidden) }
    if (e.props.hasSurvey || !snap || !snap.run || !isShown(BOARD, state)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const run = snap.run
    const { story, title, step, rest } = boardParts(run, snap.context ?? undefined)
    // el título completo va abajo sólo si arriba quedó recortado
    const full = title && run.title && title !== run.title ? run.title : null
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>{story}</Text>
          {title ? <Text> · {title}</Text> : null}
          <Text dimColor> · </Text>
          <Text color={run.waiting ? 'yellow' : undefined}>{step}</Text>
          <Text dimColor> · {rest.join(' · ')} </Text>
          <Button
            key="hide"
            label="Ocultar"
            onPress={async () => {
              await update($, hidden, (h) => (asList(h).includes(BOARD) ? asList(h) : [...asList(h), BOARD]))
              $.ui.toast(`El cartel quedó oculto en esta sesión. Para verlo de nuevo: /mods show ${BOARD}`)
            }}
          />
        </Box>
        {full ? <Text dimColor wrap="truncate-end">{full}</Text> : null}
      </Box>
    )
  })
}
