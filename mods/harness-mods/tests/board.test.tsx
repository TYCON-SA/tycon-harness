// La prueba del motor del plugin harness-mods (T17): el cartel se dibuja con una corrida en la sesión, con la
// letra chica de los avisos, no muestra dinero, /mods hide lo saca en el momento y /mods off queda guardado.
//
// Correr: claude plugin test mods/harness-mods (lo envuelve scripts/tests/harness-mods-plugin.test.sh).

import { test, expect, mock } from 'claude-code/testing'

const HOME = '/lab'
const SESSION = 'ses-7-27'
const MARKER_PATH = `${HOME}/.tycon/state/active/${SESSION}.json`
const T0 = Date.parse('2026-10-15T03:00:00Z')
const at = (min: number) => new Date(T0 + min * 60000).toISOString()

const MARKER = JSON.stringify({
  storyId: '9.9',
  startedAt: at(0),
  stepsCompleted: [0, 1, 2, 3],
  clockiStarted: true,
  adoMarkedActive: true,
  autonomous: true,
  stepTimings: { 4: { startedAt: at(28) } },
})

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 160 } as any
const RUN = { origin: { kind: 'composer' }, presentation: {} } as any

function world(on: any, files: Record<string, string>, store: Record<string, unknown> = {}, env: Record<string, string> = { HOME }) {
  mock.env(on, env)
  mock.store(on, store)
  mock.clock(on, { now: T0 + 40 * 60000 })
  // lo que hay debajo de los plugins: un evento del motor devuelve su resultado; una llamada a `$` devuelve
  // `{ value }` (o `{ deny }`)
  on('session.start', () => ({ cwd: HOME }))
  on('session.id', () => ({ value: SESSION }))
  on('session.usage', () => ({ value: { context: { percent: 21, window: 200000 } } }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_$: any, e: any) => (e.path in files ? { value: files[e.path] } : { deny: `ENOENT: ${e.path}` }))
  // lo que dibuja el motor cuando el plugin no muestra nada
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
}

const start = ($: any) => $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
const mount = ($: any) => $.ui.mount({ plugin: 'harness-mods', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

const PANE = { title: 'Story 9.9', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as any
const mountDetail = ($: any) => $.ui.mount({ plugin: 'harness-mods', component: 'Pane', requestId: 'pipeline-detail', surface: 'terminal', props: PANE })

test('el cartel es un renglón corto: story, paso, avance y minutos, sin dinero', async ($, on) => {
  world(on, { [MARKER_PATH]: MARKER })
  await start($)
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /^9\.9$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Implementar/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /4\/\d+ · 40 min/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /paso 4/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /contexto usado/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /USD|\$/ })).toBeUndefined()
})

test('el detalle trae lo que no entra en el renglón: contexto, minutos del paso y la tabla de pasos', async ($, on) => {
  world(on, { [MARKER_PATH]: MARKER })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await start($)
  const pane = await mountDetail($)
  expect(await pane.find({ type: 'Text', text: /Story 9\.9/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /contexto usado 21 %/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /min en este paso/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /USD|\$/ })).toBeUndefined()
})

test('Detalle abre la ventana del detalle', async ($, on) => {
  world(on, { [MARKER_PATH]: MARKER })
  const opened: any[] = []
  on('ui.open', (_$: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  await start($)
  const ui = await mount($)
  await ui.press({ key: 'detail' })
  expect(opened.length).toBe(1)
  expect(opened[0].id).toBe('pipeline-detail')
  expect(await ui.find({ type: 'Text', text: /contexto usado/ })).toBeUndefined()
})

test('VS Code: sin ventanas, Detalle despliega el detalle bajo el renglón y Cerrar detalle lo vuelve a plegar', async ($, on) => {
  world(on, { [MARKER_PATH]: MARKER })
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface places panes' } }))
  await $.session.start({ cwd: HOME, surface: 'vscode', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'harness-mods', surface: 'vscode', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'detail' })
  const ctx = await ui.find({ type: 'Text', text: /contexto usado 21 %/ })
  expect(ctx).toBeDefined()
  expect((ctx!.props as any).size).toBe('caption')
  await ui.press({ key: 'close' })
  expect(await ui.find({ type: 'Text', text: /contexto usado/ })).toBeUndefined()
})

// la terminal tiene un solo tamaño y no lo mira; la extensión de VS Code dibuja «footnote» grande: ahí va el más chico,
// también en el botón, que sin texto propio sale con el tamaño del cuerpo
for (const [surface, size] of [['terminal', 'footnote'], ['vscode', 'caption']] as const) {
  test(`el cartel va con la letra chica de los avisos (${surface})`, async ($, on) => {
    world(on, { [MARKER_PATH]: MARKER })
    await $.session.start({ cwd: HOME, surface, isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'harness-mods', surface, component: 'AbovePrompt', props: PROPS })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.length).toBeGreaterThan(0)
    for (const t of texts) expect((t.props as any).size).toBe(size)
    expect(await ui.find({ type: 'Button', text: 'Ocultar' })).toBeDefined()
    // la etiqueta del botón es un Text propio, con el mismo tamaño (el recorrido de arriba ya lo mide)
    expect(await ui.find({ type: 'Text', text: 'Ocultar' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Detalle' })).toBeDefined()
  })
}

test('/mods hide lo saca en el momento; /mods show lo vuelve a mostrar', async ($, on) => {
  world(on, { [MARKER_PATH]: MARKER })
  await start($)
  const hide = await $.command.run({ command: 'mods', args: 'hide pipeline-board', ...RUN })
  expect((hide as any).text).toMatch(/oculto en esta sesión/)
  expect(await (await mount($)).find({ type: 'Text', text: /^9\.9$/ })).toBeUndefined()
  await $.command.run({ command: 'mods', args: 'show pipeline-board', ...RUN })
  expect(await (await mount($)).find({ type: 'Text', text: /^9\.9$/ })).toBeDefined()
})

test('/mods off queda guardado: una sesión que arranca apagada no dibuja y /pipeline lo dice', async ($, on) => {
  world(on, { [MARKER_PATH]: MARKER }, { off: ['pipeline-board'] })
  await start($)
  expect(await (await mount($)).find({ type: 'Text', text: /^9\.9$/ })).toBeUndefined()
  const list = await $.command.run({ command: 'mods', args: '', ...RUN })
  expect((list as any).text).toMatch(/apagado/)
  const pipe = await $.command.run({ command: 'pipeline', args: '', ...RUN })
  expect((pipe as any).text).toMatch(/está apagado/)
})

test('/mods off con el cartel prendido no revienta (el reloj se cancela) y deja de dibujar', async ($, on) => {
  world(on, { [MARKER_PATH]: MARKER })
  await start($)
  const r = await $.command.run({ command: 'mods', args: 'off pipeline-board', ...RUN })
  expect((r as any).text).toMatch(/queda apagado/)
  expect(await (await mount($)).find({ type: 'Text', text: /^9\.9$/ })).toBeUndefined()
})

test('Windows: con HOME en otra carpeta, el marker se busca también bajo USERPROFILE', async ($, on) => {
  // dos raíces distintas (en Mac las rutas tienen que ser absolutas: «C:/…» el motor la resolvería contra la carpeta)
  const winMarker = `/perfil/dev/.claude/.tycon-pipeline/active/${SESSION}.json`
  world(on, { [winMarker]: MARKER }, {}, { HOME: '/red/h', USERPROFILE: '/perfil/dev' })
  await start($)
  expect(await (await mount($)).find({ type: 'Text', text: /^9\.9$/ })).toBeDefined()
})

test('sin ejecución en la sesión no dibuja y /pipeline lo dice', async ($, on) => {
  world(on, {})
  await start($)
  expect(await (await mount($)).find({ type: 'Text', text: /Story/ })).toBeUndefined()
  const r = await $.command.run({ command: 'pipeline', args: '', ...RUN })
  expect((r as any).text).toMatch(/No hay una ejecución del pipeline/)
})

test('el título completo de la story, desde su spec, va en el detalle', async ($, on) => {
  const spec = '/repo/specs/story-9.9.md'
  const marker = JSON.stringify({ ...JSON.parse(MARKER), storyPath: 'specs/story-9.9.md', repoPath: '/repo' })
  world(on, { [MARKER_PATH]: marker, [spec]: '---\nstory: "9.9"\ntitle: "El video de 0 a 100: del arnés instalado al primer código"\n---\n# 9.9\n' })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await start($)
  const pane = await mountDetail($)
  expect(await pane.find({ type: 'Text', text: /El video de 0 a 100: del arnés instalado al primer código/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Implementar/ })).toBeDefined()
})

test('sin la spec, el cartel sigue con el número solo', async ($, on) => {
  const marker = JSON.stringify({ ...JSON.parse(MARKER), storyPath: '/no/esta.md' })
  world(on, { [MARKER_PATH]: marker })
  await start($)
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /^9\.9$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /…/ })).toBeUndefined()
})
