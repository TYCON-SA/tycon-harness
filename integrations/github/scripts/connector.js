'use strict';
// connector.js — el conector de GitHub: atiende las operaciones que declara su integration.json con los lectores del
// arnés que ya hablan con GitHub, sin cambiar lo que le piden. Contesta siempre dentro del contrato de la capa.

const path = require('path');

// los motivos de los lectores de despliegues, en el vocabulario de la capa
const MOTIVO = { sin_permiso: 'sin_credencial' };

function leerDespliegues(args, ctx) {
  const { crear } = require(path.join(ctx.root, 'scripts', 'nightly', 'deployments', 'github.js'));
  const { sanear } = require(path.join(ctx.root, 'scripts', 'nightly', 'deployments', 'deployments.js'));
  try {
    const lector = crear({ env: ctx.env, deadline: Date.now() + (args.budgetMs || 120000), ventana: args.ventana || 30 });
    return { ok: true, value: lector.leer(args.entrada, args.entorno) };
  } catch (e) {
    if (!e || !e.noMedido) throw e;
    const detalle = `${e.motivo}: ${sanear(e.detalle) || 'sin detalle'}`;
    return { ok: false, reason: MOTIVO[e.motivo] || 'no_medido', detail: e.motivo === 'sin_permiso' ? `${detalle} (la sesión de gh de esta máquina: gh auth login, o GH_TOKEN)` : detalle };
  }
}

const OPERACIONES = { 'deployments.read': leerDespliegues };

function run(operacion, args, ctx) {
  const f = OPERACIONES[operacion];
  return f ? f(args, ctx) : { ok: false, reason: 'no_soportado', detail: `GitHub no atiende ${operacion} todavía` };
}

module.exports = { run };
