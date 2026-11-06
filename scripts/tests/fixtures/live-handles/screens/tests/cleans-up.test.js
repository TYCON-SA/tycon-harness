const React = require('react');
const { render } = require('@testing-library/react');
const { Polling } = require('../src/Polling');
const { Ticker } = require('../src/Ticker');

test('clears its interval on unmount', () => {
  render(React.createElement(Ticker, { clear: true }));
});

test('stops its polling on unmount', () => {
  render(React.createElement(Polling, { stopOnUnmount: true }));
});
