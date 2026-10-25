'use strict';
// connector.js — el conector de Azure DevOps: atiende las operaciones que declara su integration.json con los lectores
// del arnés que ya hablan con Azure DevOps, sin cambiar lo que le piden (la foto de llamadas de
// scripts/tests/fixtures/platform-golden/ es la vara). Contesta siempre dentro del contrato de la capa.

const path = require('path');

// los motivos de los lectores de despliegues, en el vocabulario de la capa
const MOTIVO = { sin_permiso: 'sin_credencial', pipeline_no_encontrado: 'no_encontrado' };

function leerDespliegues(args, ctx) {
  // la organización sale sólo de la configuración de la máquina: un argumento podría mandar la credencial de az a otro host
  const rota = ctx.configProblem('ado');
  if (rota) return { ok: false, reason: 'no_medido', detail: `no pude leer la configuración de esta máquina: ${rota}` };
  const org = ctx.configValue('ado.org');
  if (!org) return { ok: false, reason: 'sin_credencial', detail: 'falta la organización de Azure DevOps de esta máquina: harness.js config set ado.org <organización>' };
  const { crear } = require(path.join(ctx.root, 'scripts', 'nightly', 'deployments', 'azure.js'));
  const { sanear } = require(path.join(ctx.root, 'scripts', 'nightly', 'deployments', 'deployments.js'));
  try {
    const lector = crear({ env: ctx.env, org, deadline: Date.now() + (args.budgetMs || 120000), ventana: args.ventana || 30 });
    return { ok: true, value: lector.leer(args.entrada, args.entorno) };
  } catch (e) {
    if (!e || !e.noMedido) throw e;
    return { ok: false, reason: MOTIVO[e.motivo] || 'no_medido', detail: `${e.motivo}: ${sanear(e.detalle) || 'sin detalle'}` };
  }
}

const OPERACIONES = { ...require('./work-items.js'), ...require('./change-requests.js'), 'deployments.read': leerDespliegues };

function run(operacion, args, ctx) {
  const f = OPERACIONES[operacion];
  return f ? f(args, ctx) : { ok: false, reason: 'no_soportado', detail: `Azure DevOps no atiende ${operacion} todavía` };
}

module.exports = { run };
