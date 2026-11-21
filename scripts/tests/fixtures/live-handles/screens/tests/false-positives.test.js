const React = require('react');
const { render } = require('@testing-library/react');

let own = null;
afterEach(() => {
  if (own) clearInterval(own);
  own = null;
});

test('a request that already answered', async () => {
  global.fetch = () => Promise.resolve({ ok: true });
  await fetch('https://api.example.test/ok');
});

test('a request that already failed', async () => {
  global.fetch = () => Promise.reject(new Error('down'));
  await expect(fetch('https://api.example.test/down')).rejects.toThrow('down');
});

test('an interval its own top-level afterEach clears', () => {
  own = setInterval(() => {}, 1000);
});

test('a timer that already fired', async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
});

test('a screen without polling', () => {
  render(React.createElement('div', null, 'static'));
});
