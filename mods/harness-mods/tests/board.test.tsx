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

test('el cartel se dibuja con la ejecución de la sesión y sin dinero', async ($, on) => {
  world(on, { [MARKER_PATH]: MARKER })
  await start($)
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /Story 9\.9/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Implementar/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /paso 4/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /contexto usado 21 %/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /USD|\$/ })).toBeUndefined()
})

for (const surface of ['terminal', 'vscode'] as const) {
  test(`el cartel va con la letra chica de los avisos (${surface})`, async ($, on) => {
    world(on, { [MARKER_PATH]: MARKER })
    await $.session.start({ cwd: HOME, surface, isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'harness-mods', surface, component: 'AbovePrompt', props: PROPS })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.length).toBeGreaterThan(0)
    for (const t of texts) expect((t.props as any).size).toBe('footnote')
  })
}

test('/mods hide lo saca en el momento; /mods show lo vuelve a mostrar', async ($, on) => {
  world(on, { [MARKER_PATH]: MARKER })
  await start($)
  const hide = await $.command.run({ command: 'mods', args: 'hide pipeline-board', ...RUN })
  expect((hide as any).text).toMatch(/oculto en esta sesión/)
  expect(await (await mount($)).find({ type: 'Text', text: /Story 9\.9/ })).toBeUndefined()
  await $.command.run({ command: 'mods', args: 'show pipeline-board', ...RUN })
  expect(await (await mount($)).find({ type: 'Text', text: /Story 9\.9/ })).toBeDefined()
})

test('/mods off queda guardado: una sesión que arranca apagada no dibuja y /pipeline lo dice', async ($, on) => {
  world(on, { [MARKER_PATH]: MARKER }, { off: ['pipeline-board'] })
  await start($)
  expect(await (await mount($)).find({ type: 'Text', text: /Story 9\.9/ })).toBeUndefined()
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
  expect(await (await mount($)).find({ type: 'Text', text: /Story 9\.9/ })).toBeUndefined()
})

test('Windows: con HOME en otra carpeta, el marker se busca también bajo USERPROFILE', async ($, on) => {
  // dos raíces distintas (en Mac las rutas tienen que ser absolutas: «C:/…» el motor la resolvería contra la carpeta)
  const winMarker = `/perfil/dev/.claude/.tycon-pipeline/active/${SESSION}.json`
  world(on, { [winMarker]: MARKER }, {}, { HOME: '/red/h', USERPROFILE: '/perfil/dev' })
  await start($)
  expect(await (await mount($)).find({ type: 'Text', text: /Story 9\.9/ })).toBeDefined()
})

test('sin ejecución en la sesión no dibuja y /pipeline lo dice', async ($, on) => {
  world(on, {})
  await start($)
  expect(await (await mount($)).find({ type: 'Text', text: /Story/ })).toBeUndefined()
  const r = await $.command.run({ command: 'pipeline', args: '', ...RUN })
  expect((r as any).text).toMatch(/No hay una ejecución del pipeline/)
})

test('el cartel trae el título corto de la story desde su spec, y el completo abajo', async ($, on) => {
  const spec = '/repo/specs/story-9.9.md'
  const marker = JSON.stringify({ ...JSON.parse(MARKER), storyPath: 'specs/story-9.9.md', repoPath: '/repo' })
  world(on, { [MARKER_PATH]: marker, [spec]: '---\nstory: "9.9"\ntitle: "El video de 0 a 100: del arnés instalado al primer código"\n---\n# 9.9\n' })
  await start($)
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /El video de 0 a 100…/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /del arnés instalado al primer código/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Implementar/ })).toBeDefined()
})

test('sin la spec, el cartel sigue con el número solo', async ($, on) => {
  const marker = JSON.stringify({ ...JSON.parse(MARKER), storyPath: '/no/esta.md' })
  world(on, { [MARKER_PATH]: marker })
  await start($)
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /Story 9\.9/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /…/ })).toBeUndefined()
})
