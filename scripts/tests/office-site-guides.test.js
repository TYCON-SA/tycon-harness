'use strict';
/*
 * office-site-guides.test.js — lo que las guías dicen de las oficinas en el sitio.
 *
 * T26 Guia_PestanaRolesAltaYDatos   la sección «Oficinas» de la guía del sitio, en los dos idiomas
 * T27 ComandoOffice_DiceQueAbre     `commands/office.md` dice cuándo abre el sitio y cuándo la página local
 * T51 Guia_DiceQueViajaTodo         las dos guías y el comando dicen que viajan los mensajes y la conversación, y que el
 *                                   sitio los guarda sólo en memoria
 *
 * Se mide el texto, no se lo copia: cada frase que se pide es la que necesita leer quien usa el sitio.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const raw = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// las guías se cortan en renglones donde caiga: una frase se busca con los espacios juntos
const flat = (text) => text.replace(/\s+/g, ' ');
const read = (rel) => flat(raw(rel));

/** La sección de un título `##` hasta el siguiente del mismo nivel, con los espacios juntos. */
function section(text, title) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trim() === `## ${title}`);
  assert.ok(at >= 0, `falta la sección «## ${title}»`);
  const end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  return flat(lines.slice(at, end < 0 ? undefined : end).join('\n'));
}

const GUIDES = [
  {
    file: 'guides/organization-site.md',
    title: 'La pestaña «Oficinas»',
    must: [
      /`site\.offices\.visibility`/,
      /de fábrica[^.]*`maintainers`/,
      /`everyone`/,
      /pide el alta sola/,
      /huella/,
      /30 días sin conectarse/,
      /lo mismo que muestra la oficina local/,
      /quien mantiene ve en vivo qué hace cada dev/,
      /wss:\/\//,
      /una sola copia del sitio/i,
      /`\/live\/machine`[^\n]*`\/live\/enroll`/,
      /canal de vuelta/,
      /`RUTAS_SIN_SESION`/,
      /check-deploy\.js/,
      /túnel/,
      /cero pasos para el dev/i,
    ],
  },
  {
    file: 'guides/organization-site.en.md',
    title: 'The «Offices» tab',
    must: [
      /`site\.offices\.visibility`/,
      /by default[^.]*`maintainers`/,
      /`everyone`/,
      /asks to join by itself/,
      /fingerprint/,
      /30 days without connecting/,
      /the same as the local office shows/i,
      /maintainers see live what each dev is doing/,
      /wss:\/\//,
      /a single copy of the site/i,
      /`\/live\/machine`[^\n]*`\/live\/enroll`/,
      /back channel/,
      /`RUTAS_SIN_SESION`/,
      /check-deploy\.js/,
      /tunnel/,
      /zero steps for the dev/i,
    ],
  },
];

test('T26 Guia_PestanaRolesAltaYDatos — @story-8.171 @ac-21: la pestaña, los roles, el alta, qué sale y lo que decidió el dueño', () => {
  for (const g of GUIDES) {
    const s = section(raw(g.file), g.title);
    for (const re of g.must) assert.match(s, re, `${g.file}: ${re}`);
    // lo que decidió el dueño, de D1 a D7, cada una con su nombre
    for (const d of ['D1', 'D1b', 'D2', 'D2b', 'D3', 'D4', 'D5', 'D7']) assert.match(s, new RegExp(`\\*\\*${d}\\b`), `${g.file}: falta ${d}`);
  }
});

test('T27 ComandoOffice_DiceQueAbre — @story-8.171 @ac-21: cuándo abre el sitio y cuándo la página local', () => {
  const c = read('commands/office.md');
  assert.match(c, /aprobada[^.]*abre la pestaña «Oficinas» del sitio/);
  assert.match(c, /`--local`/);
  assert.match(c, /sin sitio[^.]*la página local/i);
  assert.match(c, /espera la aprobación[^.]*huella/);
});

test('T51 Guia_DiceQueViajaTodo — @story-8.171 @ac-28: viajan los mensajes entre sesiones y la conversación, sólo en memoria', () => {
  const c = read('commands/office.md');
  assert.doesNotMatch(c, /La conversación no se guarda ni sale de la máquina/, 'la frase de antes ya no es cierta');
  assert.match(c, /mensajes entre sesiones/);
  assert.match(c, /la conversación de cada sesión/);
  assert.match(c, /sólo en (?:su )?memoria/);
  const es = section(raw('guides/organization-site.md'), 'La pestaña «Oficinas»');
  assert.match(es, /mensajes entre sesiones/);
  assert.match(es, /la conversación de cada sesión/);
  assert.match(es, /sólo en (?:su )?memoria/);
  const en = section(raw('guides/organization-site.en.md'), 'The «Offices» tab');
  assert.match(en, /messages between sessions/);
  assert.match(en, /each session's conversation/);
  assert.match(en, /only in (?:its )?memory/);
});
