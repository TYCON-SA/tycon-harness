const React = require('react');
const { render } = require('@testing-library/react');
const { Loader } = require('../src/Loader');

test('leaves a request without an answer', () => {
  global.fetch = () => new Promise(() => {});
  render(React.createElement(Loader));
});
