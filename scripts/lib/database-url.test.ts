import { describe, expect, it } from 'vitest';

import { databaseUrlFor } from './database-url.mjs';

describe('databaseUrlFor', () => {
  it('names the database after the environment when the URL names none', () => {
    expect(databaseUrlFor('postgres://postgres@localhost:5432', 'development')).toBe(
      'postgres://postgres@localhost:5432/flashsale_development',
    );
    expect(databaseUrlFor('postgres://u:p@db:5432/', 'test')).toBe(
      'postgres://u:p@db:5432/flashsale_test',
    );
  });

  // Naming a database is a deliberate choice, and overriding it would be a
  // surprise — the worst kind with an E2E reset that wipes orders.
  it('takes a URL that names a database as it is', () => {
    expect(databaseUrlFor('postgres://u:p@db:5432/flashsale', 'e2e')).toBe(
      'postgres://u:p@db:5432/flashsale',
    );
  });

  it('keeps connection options either way', () => {
    expect(databaseUrlFor('postgres://u:p@db:5432?sslmode=require', 'e2e')).toBe(
      'postgres://u:p@db:5432/flashsale_e2e?sslmode=require',
    );
    expect(databaseUrlFor('postgres://u:p@db/orders?sslmode=require', 'e2e')).toBe(
      'postgres://u:p@db/orders?sslmode=require',
    );
  });
});
