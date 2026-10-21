// El contrato del estado del plugin harness-mods: lo que el motor guarda por sesión.

export type BoardRow = { id: string; name: string; state: string; minutes: number | null }

export type Run = {
  storyId: string
  /** El título de la story (del marker o del frontmatter de su spec); `null` si no se encontró. */
  title?: string | null
  current: { id: string; name: string } | null
  done: number
  total: number
  minutesStep: number | null
  minutesTotal: number | null
  waiting: boolean
  rows: BoardRow[]
}

/** La última lectura del marker: lo que dibuja el renglón. `run: null` = no hay corrida en la sesión. */
/** `readError`: el marker está pero no se pudo leer. `error`: falló la actualización del cartel. */
export type Snapshot = { run: Run | null; context: number | null; readError?: string | null; error?: string | null }

declare module 'claude-code' {
  interface PluginState {
    'harness-mods': {
      snapshot: Snapshot | null
      /** Los mods ocultos en esta sesión (`/mods hide`). */
      hidden: string[]
      /** Los mods apagados (`/mods off`): copia de la sesión de lo que guarda `$.store`. */
      off: string[]
      /** Las claves `story:paso` que ya tuvieron su aviso de «te espera». */
      warned: string[]
      /** El `story:paso` que esperaba al dev la última vez (el pipeline borra la bandera al cerrar el turno). */
      waitingFor: string | null
    }
  }
}
