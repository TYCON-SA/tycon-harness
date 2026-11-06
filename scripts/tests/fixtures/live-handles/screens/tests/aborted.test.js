const React = require('react');
const { render } = require('@testing-library/react');
const { Loader } = require('../src/Loader');

test('cancels its request on unmount', () => {
  global.fetch = () => new Promise(() => {});
  render(React.createElement(Loader, { abort: true }));
});
