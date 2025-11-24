const providerFactory = require('../lib');

describe('strapi-provider-cloudflare-r2-advanced', () => {
  it('exports an init function', () => {
    expect(typeof providerFactory.init).toBe('function');
  });
});
