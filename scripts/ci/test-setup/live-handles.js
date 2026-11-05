'use strict';
/**
 * El detector de consultas y temporizadores vivos, del lado de la prueba: corre como el ÚLTIMO `setupFilesAfterEnv`
 * (lo pone ahí jest.live-handles.config.js) y anota todo lo que una prueba deja andando. No decide nada: quien mira y
 * hace fallar es el entorno (live-handles-env.js), al terminar cada prueba.
 *
 * 🔴 POR QUÉ EXISTE. Una pantalla que consulta en un bucle que no se corta al desmontar deja la consulta viva al terminar la
 * prueba, y esa consulta le gasta la respuesta simulada a la prueba siguiente: falla OTRA, a veces. Medido en un repo de
 * formularios: el arreglo del caso nombraba tres pruebas, y este detector marcó exactamente esas tres.
 *
 * Lo que hace que mida bien (cada punto salió de un falso positivo o de una rotura medida):
 *   · la simulación de `fetch` de la prueba se ENVUELVE con un Proxy, nunca se reemplaza: copiar `.mock` a otra función
 *     rompió tres pruebas que leían `global.fetch.mock.calls`. Se envuelve también lo que la prueba asigna después;
 *   · `jest.spyOn(global, 'fetch')` cambia el getter de `fetch` por el suyo y deja la envoltura afuera: el entorno lo
 *     detecta y la vuelve a poner (`rewrapFetch`);
 *   · el `cleanup` es el de la MISMA Testing Library que usan las pruebas, resuelta desde el formulario;
 *   · nada de esto puede tumbar una prueba: un error propio se traga acá y lo anota el entorno.
 */
const fs = require('fs');
const path = require('path');

const g = globalThis;
const HERE = __dirname;

function install() {
  const reg = {
    timers: new Map(),
    fetches: new Set(),
    inTest: false,
    cleanup: null,
    original: { setTimeout: g.setTimeout, clearTimeout: g.clearTimeout, setInterval: g.setInterval, clearInterval: g.clearInterval },
  };
  const formDir = process.env.LIVE_HANDLES_FORM_DIR || process.cwd();
  const out = process.env.LIVE_HANDLES_OUT;
  const file = (expect.getState().testPath || '').replace(`${formDir}${path.sep}`, '').replace(/\\/g, '/');
  const note = (record) => {
    if (!out) return;
    try { fs.appendFileSync(out, `${JSON.stringify(record)}\n`); } catch (e) {
      process.stderr.write(`##vso[task.logissue type=warning]consultas vivas: no pude anotar en ${out} (${e.message})\n`);
    }
  };
  // Un registro roto deja de ver lo que se crea: se anota una vez como error interno, y el informe no lo da por limpio.
  const broken = (e) => {
    if (reg.brokenOnce) return;
    reg.brokenOnce = true;
    note({ event: 'internal-error', file, message: `el registro del detector falló: ${e && e.message ? e.message : e}` });
  };

  /**
   * Dónde se creó: el marco que llamó al temporizador o a fetch. Si es de una biblioteca de node_modules, se dice el
   * paquete y, entre paréntesis, la línea del formulario que la llamó.
   */
  reg.where = function where() {
    const frames = String(new Error().stack || '').split('\n').slice(1)
      .map((l) => l.match(/\(?((?:[A-Za-z]:)?[\\/][^():]+):(\d+):\d+\)?\s*$/))
      .filter((m) => m && !m[1].startsWith(HERE) && !m[1].startsWith('node:'));
    const at = (m) => `${path.relative(formDir, m[1]).replace(/\\/g, '/')}:${m[2]}`;
    const inLib = (m) => /[\\/]node_modules[\\/]/.test(m[1]);
    const first = frames[0];
    if (!first) return 'origen desconocido';
    if (!inLib(first)) return at(first);
    const pkg = first[1].replace(/\\/g, '/').split('/node_modules/').pop().split('/');
    const own = frames.find((m) => !inLib(m));
    return `de node_modules: ${pkg[0].startsWith('@') ? `${pkg[0]}/${pkg[1]}` : pkg[0]} (${at(own || first)})`;
  };

  // Con el entorno node, el id es un objeto Timeout que también se puede limpiar por su número: se guardan los dos.
  const byNumber = new Map();
  const remember = (id, info) => {
    try {
      reg.timers.set(id, info);
      if (id && typeof id === 'object' && typeof id[Symbol.toPrimitive] === 'function') byNumber.set(Number(id), id);
    } catch (e) { broken(e); }
  };
  const forget = (id) => {
    try {
      const key = typeof id === 'number' && byNumber.has(id) ? byNumber.get(id) : id;
      reg.timers.delete(key);
      if (key && typeof key === 'object') byNumber.delete(Number(key));
    } catch (e) { broken(e); }
  };

  reg.wrappers = {
    setTimeout: function setTimeout(fn, ms, ...args) {
      let id;
      const cb = typeof fn === 'function' ? function (...a) { forget(id); return fn.apply(this, a); } : fn;
      id = Reflect.apply(reg.original.setTimeout, g, [cb, ms, ...args]);
      remember(id, { kind: 'setTimeout', ms: Number(ms) || 0, where: reg.where(), inTest: reg.inTest });
      return id;
    },
    setInterval: function setInterval(fn, ms, ...args) {
      const id = Reflect.apply(reg.original.setInterval, g, [fn, ms, ...args]);
      remember(id, { kind: 'setInterval', ms: Number(ms) || 0, where: reg.where(), inTest: reg.inTest });
      return id;
    },
    clearTimeout: function clearTimeout(id) { forget(id); return Reflect.apply(reg.original.clearTimeout, g, [id]); },
    clearInterval: function clearInterval(id) { forget(id); return Reflect.apply(reg.original.clearInterval, g, [id]); },
  };
  Object.assign(g, reg.wrappers);
  const isFake = (f) => !!(f && (f.clock || f._isMockFunction));

  // fetch: la prueba lo REASIGNA (global.fetch = jest.fn(...)); se envuelve lo que asigne, sin reemplazarlo.
  const wrapped = new WeakMap();
  const trim = (input) => String(input && typeof input === 'object' && 'url' in input ? input.url : input).split(/[?#]/)[0].slice(0, 80);
  reg.wrap = function wrap(f) {
    if (typeof f !== 'function') return f;
    if (wrapped.has(f)) return wrapped.get(f);
    const p = new Proxy(f, {
      apply(target, self, args) {
        const res = Reflect.apply(target, self, args);
        if (res && typeof res.then === 'function') {
          // La señal llega en las opciones o dentro de un Request: fetch(new Request(url, { signal })).
          const signal = (args[1] && args[1].signal) || (args[0] && typeof args[0] === 'object' && args[0].signal) || null;
          const call = { url: trim(args[0]), where: reg.where(), signal, inTest: reg.inTest };
          try { reg.fetches.add(call); } catch (e) { broken(e); }
          const done = () => { try { reg.fetches.delete(call); } catch (e) { broken(e); } };
          res.then(done, done);
        }
        return res;
      },
    });
    wrapped.set(f, p);
    wrapped.set(p, p);
    return p;
  };
  let current = reg.wrap(g.fetch);
  const accessor = { configurable: true, enumerable: true, get() { return current; }, set(v) { current = reg.wrap(v); } };
  Object.defineProperty(g, 'fetch', accessor);

  // `Object.defineProperty(global, 'fetch', { value })` pisaría el accessor: se vuelve a poner con ese valor envuelto.
  const defineProperty = g.Object.defineProperty;
  g.Object.defineProperty = function (target, key, desc) {
    if (target === g && key === 'fetch' && desc && 'value' in desc) {
      current = reg.wrap(desc.value);
      return Reflect.apply(defineProperty, this, [target, key, accessor]);
    }
    return Reflect.apply(defineProperty, this, [target, key, desc]);
  };

  /** Después de `jest.spyOn(global, 'fetch')`: el getter devuelve el espía; se lo envuelve sin tocar su restauración. */
  reg.rewrapFetch = function rewrapFetch() {
    const d = Object.getOwnPropertyDescriptor(g, 'fetch');
    if (!d || !d.get || d.get === accessor.get) return;
    const spyGet = d.get;
    defineProperty(g, 'fetch', { ...d, get() { return reg.wrap(spyGet()); } });
  };

  /**
   * Vuelve a poner las envolturas que una prueba sacó, sin tocar las simuladas: `delete global.fetch` (y lo que se asigne
   * después) y `useRealTimers()` de los temporizadores simulados legacy, que reponen los que el entorno guardó antes del
   * detector. Lo llama el entorno al empezar cada prueba, cada gancho y antes de mirar.
   */
  reg.ensure = function ensure() {
    if (!isFake(g.setTimeout) && g.setTimeout !== reg.wrappers.setTimeout) Object.assign(g, reg.wrappers);
    const d = Object.getOwnPropertyDescriptor(g, 'fetch');
    if (!d || 'value' in d) {
      current = reg.wrap(d ? d.value : undefined);
      defineProperty(g, 'fetch', accessor);
    }
  };

  // Un archivo con `@jest-environment` en su cabecera cambia el entorno por el suyo: ahí nadie mira. Se dice.
  if (!g.__tyconLiveHandlesEnv) {
    note({ event: 'no-detector-file', file, reason: 'el archivo declara su propio entorno (@jest-environment): corrió sin el detector' });
  }

  // La misma Testing Library que usan las pruebas (la ruta la resuelve la configuración desde el formulario).
  const rtl = process.env.LIVE_HANDLES_TESTING_LIBRARY;
  try {
    if (!rtl) throw new Error('el formulario no tiene @testing-library/react');
    reg.cleanup = require(rtl).cleanup;
  } catch (e) {
    reg.noTestingLibrary = e.message;
    note({ event: 'no-testing-library', file, reason: e.message });
  }

  g.__tyconLiveHandles = reg;
}

if (!g.__tyconLiveHandles) install();
