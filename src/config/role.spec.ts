import { getRole, isWorker, isWeb } from './role';

describe('role helper', () => {
  const original = process.env.ROLE;
  afterEach(() => {
    if (original === undefined) delete process.env.ROLE;
    else process.env.ROLE = original;
  });

  it('defaults to web when ROLE is unset', () => {
    delete process.env.ROLE;
    expect(getRole()).toBe('web');
    expect(isWeb()).toBe(true);
    expect(isWorker()).toBe(false);
  });

  it('returns worker when ROLE=worker', () => {
    process.env.ROLE = 'worker';
    expect(getRole()).toBe('worker');
    expect(isWorker()).toBe(true);
    expect(isWeb()).toBe(false);
  });

  it('is case-insensitive and trims whitespace', () => {
    process.env.ROLE = '  WORKER ';
    expect(getRole()).toBe('worker');
  });

  it('falls back to web for an unknown value', () => {
    process.env.ROLE = 'banana';
    expect(getRole()).toBe('web');
  });
});
