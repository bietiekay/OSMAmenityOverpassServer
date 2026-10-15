import { describe, expect, it } from 'vitest';
import { buildLogger } from '../src/logger.js';

describe('configured log verbosity', () => {
  it.each([['errors', 'error'], ['info', 'info'], ['debug', 'debug']] as const)(
    'maps %s to the matching operational threshold', (verbosity, level) => {
      const logger = buildLogger(verbosity);
      expect(logger.level).toBe(level);
      expect(logger.isLevelEnabled('debug')).toBe(verbosity === 'debug');
      expect(logger.isLevelEnabled('info')).toBe(verbosity !== 'errors');
      expect(logger.isLevelEnabled('error')).toBe(true);
    }
  );
});
