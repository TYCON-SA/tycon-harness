#!/usr/bin/env node
/**
 * owner-approval-record.js — anota la aprobación explícita de la persona, para que una firma la use sin terminal
 * (scripts/lib/owner-approvals.js).
 *
 *   UserPromptSubmit                → si el mensaje lo escribió la persona y dice «aprob…», lo anota
 *   PostToolUse sobre AskUserQuestion → si la respuesta del cuadro aprueba, anota el click
 *
 * Lee sólo lo que trae el evento: el prompt y la respuesta real del cuadro (`tool_response`, nunca `tool_input`). Anota
 * sólo si lo lanzó la herramienta (el árbol de procesos), no la consola de un agente. No
 * frena nada: todo error sale 0 sin salida (una aprobación que no se anotó se pide de nuevo). Off: TYCON_OWNER_APPROVALS=0.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');

/** Lo que el gancho anota para un evento, o null. `casa`: la de la cuenta. */
function registroDe(evento, { ahora = Date.now() } = {}) {
  const oa = require(path.join(LIB, 'owner-approvals.js'));
  const e = evento && typeof evento === 'object' ? evento : {};
  const sesion = String(e.session_id || '');
  if (!/^[\w-]+$/.test(sesion)) return null;
  // la transcripción y la carpeta no se guardan: al consumir salen de la sesión y de la firma, no de lo que diga el evento
  const comun = { sesion, ts: new Date(ahora).toISOString() };
  if (e.hook_event_name === 'UserPromptSubmit') {
    const texto = oa.mensajeDeLaPersona(e.prompt);
    return texto ? { tipo: 'mensaje', ...comun, texto } : null;
  }
  if (e.hook_event_name === 'PostToolUse' && e.tool_name === 'AskUserQuestion') {
    const r = oa.respuestaDelCuadro(e.tool_response);
    return r.ok ? { tipo: 'click', ...comun, tool_use_id: e.tool_use_id ? String(e.tool_use_id) : null, pregunta: r.pregunta, respuesta: r.respuesta } : null;
  }
  return null;
}

function main() {
  if (process.env.TYCON_OWNER_APPROVALS === '0') return;
  let evento;
  try { evento = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '')); } catch (_) { return; }
  const r = registroDe(evento);
  if (!r) return;
  const casa = require(path.join(LIB, 'real-home.js')).casaDeLaCuenta();
  const oa = require(path.join(LIB, 'owner-approvals.js'));
  // sólo lo que lanza la herramienta: un agente que corre este gancho a mano, o que abre otra sesión y le escribe, no anota
  const h = oa.lanzadoPorLaHerramienta({ casa });
  if (!h.ok) return;
  oa.anotar(casa, { ...r, herramienta: h.herramienta });
}

if (require.main === module) {
  try { main(); } catch (_) { /* no frena: una aprobación que no se anotó se pide de nuevo */ }
  process.exit(0);
}

module.exports = { registroDe };
