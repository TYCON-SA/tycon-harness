'use strict';
/**
 * Lo carga NODE_OPTIONS en las corridas comparadas (historia 8.167): corta la red dentro de Node. Una conexión TCP
 * (net, http, https), una consulta de nombres (dns) o un `fetch` fallan con «compare: sin red» y dejan su marca en
 * TYCON_COMPARE_MARKS: el resultado de la comparación es «no comparado: usa la red». Una conexión local por ruta (un
 * socket de archivo) no es red y sigue.
 */
const fs = require('fs');

function marcar(que) {
  const f = process.env.TYCON_COMPARE_MARKS;
  if (f) { try { fs.appendFileSync(f, `node ${que}\n`); } catch (_) { /* sin marca, igual se corta */ } }
}
const error = (que) => { marcar(que); const e = new Error(`compare: sin red (${que})`); e.code = 'ECOMPARENONET'; return e; };

const net = require('net');
const esLocal = (args) => {
  const o = args[0];
  if (o && typeof o === 'object' && !Array.isArray(o)) return typeof o.path === 'string';
  return typeof o === 'string' && !/^\d+$/.test(o);
};
const conectar = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  if (esLocal(args)) return conectar.apply(this, args);
  const e = error('net');
  process.nextTick(() => this.destroy(e));
  return this;
};

for (const nombre of ['http', 'https']) {
  const m = require(nombre);
  const cortar = (...args) => {
    const o = args.find((a) => a && typeof a === 'object' && !(a instanceof URL));
    if (o && typeof o.socketPath === 'string') return null;
    throw error(nombre);
  };
  const request = m.request;
  const get = m.get;
  m.request = (...args) => { cortar(...args); return request.apply(m, args); };
  m.get = (...args) => { cortar(...args); return get.apply(m, args); };
}

const dns = require('dns');
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveTxt', 'resolveSrv', 'reverse']) {
  if (typeof dns[k] !== 'function') continue;
  dns[k] = (...args) => {
    const cb = args.find((a) => typeof a === 'function');
    const e = error('dns');
    if (cb) process.nextTick(() => cb(e));
    else throw e;
  };
  if (dns.promises && typeof dns.promises[k] === 'function') dns.promises[k] = async () => { throw error('dns'); };
}

if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = async () => { throw error('fetch'); };
}
