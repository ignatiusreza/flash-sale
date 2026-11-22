import { describe, expect, it } from 'vitest';

import { loadConfig, testEndpointsEnabled } from './config.js';

const required = {
  DATABASE_URL: 'postgres://localhost/flashsale',
  RABBITMQ_URL: 'amqp://localhost',
};

const trustProxy = (value?: string) =>
  loadConfig({ ...required, ...(value === undefined ? {} : { TRUST_PROXY: value }) }).TRUST_PROXY;

describe('TRUST_PROXY', () => {
  it('trusts nothing unless asked', () => {
    expect(trustProxy()).toBe(false);
    expect(trustProxy('')).toBe(false);
    expect(trustProxy('false')).toBe(false);
    expect(trustProxy('0')).toBe(false);
  });

  it('trusts the whole chain when told to', () => {
    expect(trustProxy('true')).toBe(true);
  });

  it('takes a list of proxy addresses', () => {
    expect(trustProxy('10.0.0.0/8, loopback')).toEqual(['10.0.0.0/8', 'loopback']);
  });

  // Fastify maps a hop count onto a function that trusts nobody, so accepting
  // one would leave the operator believing they had configured something.
  it('refuses a hop count rather than silently trusting nothing', () => {
    expect(() => trustProxy('1')).toThrow(/hop count/);
  });
});

// The reset endpoint wipes orders, so it must exist in exactly one environment.
describe('test endpoints', () => {
  const enabledIn = (APP_ENV?: string) =>
    testEndpointsEnabled(loadConfig({ ...required, ...(APP_ENV ? { APP_ENV } : {}) }));

  it('exist only in the E2E environment', () => {
    expect(enabledIn('e2e')).toBe(true);
  });

  it('never exist anywhere else — including with nothing set', () => {
    expect(enabledIn()).toBe(false);
    expect(enabledIn('production')).toBe(false);
    expect(enabledIn('development')).toBe(false);
    expect(enabledIn('test')).toBe(false);
  });
});
