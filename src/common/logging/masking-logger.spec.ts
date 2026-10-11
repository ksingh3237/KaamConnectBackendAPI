import { vi } from 'vitest';
import { MaskingLogger } from './masking-logger.js';

describe('MaskingLogger', () => {
  let written: string;
  beforeEach(() => {
    written = '';
    const capture = (chunk: unknown) => {
      written += String(chunk);
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture as never);
  });
  afterEach(() => vi.restoreAllMocks());

  // Colours are added by Nest when it thinks a terminal is attached.
  const output = () =>
    written.replace(
      new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'),
      '',
    );

  it('masks phone numbers and credentials in plain messages', () => {
    new MaskingLogger('Test').log(
      'OTP failed for +919876543210 with token=abc123 and Bearer xyz.abc',
    );
    expect(output()).toContain('OTP failed for +9198****3210');
    expect(output()).not.toMatch(/9876543210|abc123|xyz\.abc/);
  });

  it('masks inside an Error that is logged, including its stack', () => {
    const error = new Error('Unique constraint failed on phone +919876543210');
    new MaskingLogger('Test').error(error);
    expect(output()).toContain('Unique constraint failed');
    expect(output()).not.toContain('9876543210');
  });

  it('masks inside an explicit stack string passed with the message', () => {
    new MaskingLogger('Test').error(
      'Something failed',
      'Error: bad\n    at call (file.ts:1:1) data +919123456789',
    );
    expect(output()).toContain('Something failed');
    expect(output()).not.toContain('9123456789');
  });

  it('replaces sensitive properties when an object is logged', () => {
    new MaskingLogger('Test').log({
      jobId: 'job-1',
      phone: '+919876543210',
      accessToken: 'secret-token-value',
      arrivalCode: '4821',
      addressLine: '12 Private Lane',
    });
    const out = output();
    expect(out).toContain('job-1');
    expect(out).not.toMatch(
      /9876543210|secret-token-value|4821|12 Private Lane/,
    );
    expect(out).toContain('[REDACTED]');
  });

  it('an error message with no stack is a normal log line, not a crash (Nest passes an undefined stack)', () => {
    const logger = new MaskingLogger('Test');
    expect(() => logger.error('plain failure, no stack')).not.toThrow();
    expect(() => logger.fatal('plain fatal')).not.toThrow();
    expect(output()).toContain('plain failure, no stack');
  });

  it('leaves ordinary messages exactly as they were', () => {
    new MaskingLogger('Test').warn('Expired 3 unanswered request(s)');
    expect(output()).toContain('Expired 3 unanswered request(s)');
  });
});
