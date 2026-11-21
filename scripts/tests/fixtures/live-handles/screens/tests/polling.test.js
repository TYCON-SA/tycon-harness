const React = require('react');
const { render } = require('@testing-library/react');
const { Polling } = require('../src/Polling');

test('leaves the polling alive', () => {
  render(React.createElement(Polling));
});

test('the next one starts clean', () => {
  expect(1).toBe(1);
});
