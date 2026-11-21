'use strict';
/**
 * El entorno de jest que MIRA: extiende el del formulario (jsdom, node o el suyo, que le pasa la configuración en
 * LIVE_HANDLES_BASE_ENV) y, al terminar cada prueba, hace fallar la que dejó una consulta o un temporizador vivo.
 *
 * 🔴 POR QUÉ MIRA ACÁ Y NO EN UN afterEach. Medido con jest 29.7: un afterEach registrado desde setupFilesAfterEnv corre
 * ANTES que los afterEach de primer nivel del archivo de prueba, así que marcaría lo que la prueba limpia en el suyo. El
 * evento `test_done` del entorno llega después de TODOS los afterEach, y un error agregado ahí hace fallar esa prueba.
 *
 * Al terminar cada prueba: desmonta (cleanup de Testing Library), espera un turno, junta lo que se creó DURANTE la prueba y
 * sigue vivo (una consulta cancelada con su AbortSignal no cuenta; los temporizadores simulados cuentan por
 * `jest.getTimerCount()`), lo limpia para que no contamine a la siguiente, y recién ahí informa: en `block` falla la prueba
 * salvo que una excepción vigente la ampare (declared.js); en `warn` sólo anota. Lo creado fuera de una prueba (al importar
 * el módulo, en beforeAll) se mira al final del archivo: no es de ninguna prueba, y en `block` falla el archivo.
 *
 * Variables (las pone el paso de pruebas del pipeline): LIVE_HANDLES_MODE (warn | block; otra cosa es block),
 * LIVE_HANDLES_FORM (el formulario), LIVE_HANDLES_OUT (el archivo de anotaciones, JSONL), LIVE_HANDLES_DECLARED (la lista
 * de excepciones) y LIVE_HANDLES_TODAY (sólo para las pruebas). Un error propio nunca falla una prueba: se anota.
 */
const fs = require('fs');
const path = require('path');
const declared = require('./declared.js');

function loadBase() {
  const wanted = process.env.LIVE_HANDLES_BASE_ENV;
  const target = wanted || require.resolve('jest-environment-node', { paths: [process.cwd()] });
  const mod = require(target);
  return mod.TestEnvironment || mod.default || mod;
}

const Base = loadBase();
const ROOT_BLOCK = 'ROOT_DESCRIBE_BLOCK';
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

/** El nombre completo de la prueba, como `expect.getState().currentTestName`. */
function fullName(test) {
  const names = [];
  for (let t = test; t && t.name !== ROOT_BLOCK; t = t.parent) names.unshift(t.name);
  return names.join(' ');
}

const describe = (h) => (h.kind === 'fetch' ? `fetch ${h.url} ${h.where}`
  : h.kind === 'fake' ? `temporizadores simulados pendientes: ${h.count} (jest.getTimerCount())`
    : `${h.kind}(${h.ms} ms) ${h.where}`);

function problem(title, handles) {
  const e = new Error(`${title}\n${handles.map((h) => `  ${describe(h)}`).join('\n')}`);
  e.stack = e.message;
  return e;
}

class LiveHandlesEnvironment extends Base {
  constructor(config, context) {
    super(config, context);
    const formDir = process.env.LIVE_HANDLES_FORM_DIR || process.cwd();
    this.lh = {
      mode: process.env.LIVE_HANDLES_MODE === 'warn' ? 'warn' : 'block',
      form: process.env.LIVE_HANDLES_FORM || path.basename(formDir),
      out: process.env.LIVE_HANDLES_OUT || null,
      file: path.relative(formDir, context.testPath).replace(/\\/g, '/'),
      today: declared.today(),
      looked: 0,
      seen: [],
      failedOnce: false,
    };
    const list = declared.read(process.env.LIVE_HANDLES_DECLARED);
    this.lh.entries = list.entries;
    this.lh.watchSeen = list.entries.some((e) => e && e.form === this.lh.form && declared.normalize(e.file) === this.lh.file);
    // Una lista ilegible no ampara a nadie, pero el detector mira igual: no es «sin el detector». El informe la lee aparte.
    if (list.error) this.write({ event: 'declared-error', file: this.lh.file, message: list.error });
    // live-handles.js lo mira: un archivo con `@jest-environment` propio corre sin este entorno, y eso se dice.
    this.global.__tyconLiveHandlesEnv = true;
    // jest.spyOn(global, 'fetch') reemplaza la envoltura: se la vuelve a poner después de cada espía sobre fetch.
    try {
      const mm = this.moduleMocker;
      const spyOn = mm.spyOn.bind(mm);
      mm.spyOn = (object, key, ...rest) => {
        const spy = spyOn(object, key, ...rest);
        try {
          if (object === this.global && key === 'fetch' && !rest[0] && this.global.__tyconLiveHandles) this.global.__tyconLiveHandles.rewrapFetch();
        } catch (e) { this.internal(e); }
        return spy;
      };
    } catch (e) { this.internal(e); }
  }

  write(record) {
    if (!this.lh.out) return;
    try { fs.appendFileSync(this.lh.out, `${JSON.stringify({ form: this.lh.form, ...record })}\n`); } catch (e) {
      // Sin dónde anotar, el informe va a decir «no medido»; el motivo queda en la salida del paso.
      if (!this.lh.writeFailed) process.stderr.write(`##vso[task.logissue type=warning]consultas vivas: no pude anotar en ${this.lh.out} (${e.message})\n`);
      this.lh.writeFailed = true;
    }
  }

  internal(e) {
    this.write({ event: 'internal-error', file: this.lh.file, message: String(e && e.message ? e.message : e) });
  }

  async setup() {
    await super.setup();
    // La fecha con la que se juzgaron las excepciones: el informe usa la misma, aunque corra después de medianoche.
    this.write({ event: 'file', file: this.lh.file, today: this.lh.today });
  }

  /** Lo que sigue vivo de lo creado con `inTest === which`, ya limpiado. */
  collect(reg, which) {
    const handles = [];
    for (const [id, h] of reg.timers) {
      if (h.inTest !== which) continue;
      handles.push(h);
      try { Reflect.apply(reg.original.clearTimeout, this.global, [id]); Reflect.apply(reg.original.clearInterval, this.global, [id]); } catch (_) { /* ya no está */ }
      reg.timers.delete(id);
    }
    for (const f of [...reg.fetches]) {
      if (f.inTest !== which) continue;
      reg.fetches.delete(f);
      if (f.signal && f.signal.aborted) continue;
      handles.push({ kind: 'fetch', url: f.url, where: f.where });
    }
    return handles;
  }

  /** Temporizadores simulados pendientes, limpiados; 0 con los reales. */
  fake() {
    const st = this.global.setTimeout;
    if (!st) return 0;
    const timers = st.clock ? this.fakeTimersModern : st._isMockFunction ? this.fakeTimers : null;
    if (!timers || typeof timers.getTimerCount !== 'function') return 0;
    const count = timers.getTimerCount();
    if (count) timers.clearAllTimers();
    return count;
  }

  async testDone(test) {
    const reg = this.global.__tyconLiveHandles;
    if (!reg) throw new Error('el detector no se cargó (falta live-handles.js en setupFilesAfterEnv)');
    reg.inTest = false;
    const name = fullName(test);
    this.lh.looked += 1;
    if (this.lh.watchSeen) this.lh.seen.push(name);
    if (reg.cleanup) reg.cleanup();
    await turn();
    reg.ensure();
    const handles = this.collect(reg, true);
    const count = this.fake();
    if (count) handles.push({ kind: 'fake', count });
    if (!handles.length) return;
    const excuse = declared.excuses(this.lh.entries, { form: this.lh.form, file: this.lh.file, test: name }, this.lh.today);
    this.write({ event: 'test', file: this.lh.file, test: name, excused: !!excuse, handles });
    if (this.lh.mode === 'block' && !excuse) test.errors.push(problem('quedó vivo al terminar la prueba:', handles));
  }

  runFinish(state) {
    const reg = this.global.__tyconLiveHandles;
    this.write({ event: 'looked', file: this.lh.file, count: this.lh.looked, tests: this.lh.seen });
    if (!reg) return;
    const handles = this.collect(reg, false);
    if (!handles.length) return;
    this.write({ event: 'outside', file: this.lh.file, handles });
    if (this.lh.mode === 'block') state.unhandledErrors.push(problem(`creado fuera de una prueba, vivo al terminar ${this.lh.file}:`, handles));
  }

  async handleTestEvent(event, state) {
    if (typeof super.handleTestEvent === 'function') await super.handleTestEvent(event, state);
    try {
      const reg = this.global.__tyconLiveHandles;
      // Antes de cada prueba y de cada gancho, las envolturas vuelven si la prueba anterior las sacó.
      if (reg && (event.name === 'test_start' || event.name === 'test_fn_start' || event.name === 'hook_start')) reg.ensure();
      if (event.name === 'test_start' && reg) reg.inTest = true;
      else if (event.name === 'test_done') await this.testDone(event.test);
      else if (event.name === 'run_finish') this.runFinish(state);
    } catch (e) {
      if (!this.lh.failedOnce) this.internal(e);
      this.lh.failedOnce = true;
    }
  }
}

module.exports = LiveHandlesEnvironment;
module.exports.TestEnvironment = LiveHandlesEnvironment;
