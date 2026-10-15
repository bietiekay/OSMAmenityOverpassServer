import pino from 'pino';

export const buildLogger = (verbosity: 'errors' | 'info' | 'debug'): pino.Logger => {
  const level = verbosity === 'errors' ? 'error' : verbosity === 'debug' ? 'debug' : 'info';
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime
  });
};

export type AppLogger = pino.Logger;
