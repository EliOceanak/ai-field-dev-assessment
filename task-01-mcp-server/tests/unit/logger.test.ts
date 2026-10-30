import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/logging/logger.js';

describe('createLogger', () => {
  it('writes one JSON object per line to stderr by default', () => {
    const written: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);

    try {
      const logger = createLogger({ now: () => new Date('2026-01-01T00:00:00.000Z') });
      logger.info('server_started', { pid: 4242 });

      expect(written).toHaveLength(1);
      expect(written[0]?.endsWith('\n')).toBe(true);
      expect(JSON.parse(written[0] ?? '{}')).toEqual({
        ts: '2026-01-01T00:00:00.000Z',
        level: 'info',
        event: 'server_started',
        pid: 4242
      });
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('never writes to stdout', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);

    try {
      // Discard the stderr output so this test does not pollute the CI log.
      const logger = createLogger({
        level: 'debug',
        stream: { write: () => true } as unknown as NodeJS.WritableStream
      });
      logger.debug('a');
      logger.info('b');
      logger.warn('c');
      logger.error('d', {}, new Error('boom'));

      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('drops events below the configured level', () => {
    const written: string[] = [];
    const logger = createLogger({
      level: 'warn',
      stream: { write: (chunk: string) => (written.push(chunk), true) } as unknown as NodeJS.WritableStream
    });

    logger.debug('debug_event');
    logger.info('info_event');
    logger.warn('warn_event');

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? '{}').event).toBe('warn_event');
  });

  it('is silent when the level is "silent"', () => {
    const written: string[] = [];
    const logger = createLogger({
      level: 'silent',
      stream: { write: (chunk: string) => (written.push(chunk), true) } as unknown as NodeJS.WritableStream
    });

    logger.error('nope');
    expect(written).toHaveLength(0);
  });

  it('serializes Error causes instead of dropping them', () => {
    const written: string[] = [];
    const logger = createLogger({
      stream: { write: (chunk: string) => (written.push(chunk), true) } as unknown as NodeJS.WritableStream
    });

    logger.error('tool_failed', { tool: 'trigger_refund' }, new Error('database unavailable'));

    const line = JSON.parse(written[0] ?? '{}');
    expect(line.event).toBe('tool_failed');
    expect(line.cause).toMatchObject({ name: 'Error', message: 'database unavailable' });
  });

  it('merges fields bound by child()', () => {
    const written: string[] = [];
    const logger = createLogger({
      base: { server: 'customer-ops-mcp' },
      stream: { write: (chunk: string) => (written.push(chunk), true) } as unknown as NodeJS.WritableStream
    });

    logger.child({ requestId: 'req-1' }).info('tool_called');

    expect(JSON.parse(written[0] ?? '{}')).toMatchObject({
      server: 'customer-ops-mcp',
      requestId: 'req-1',
      event: 'tool_called'
    });
  });
});
