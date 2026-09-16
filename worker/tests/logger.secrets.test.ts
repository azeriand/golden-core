// Secrets-not-logged unit test for the Poster_Worker logger.
//
// This test simulates a processing failure being logged and asserts that the
// captured log output contains NEITHER the DATABASE_URL value NOR the
// BLOB_READ_WRITE_TOKEN value. Even when an error message embeds those secrets
// verbatim (the worst case), the logger's defensive redaction pass must scrub
// them before anything is written (Requirements 14.3, 14.4).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger, redactSecrets, describeError } from '../src/logger.js';

// Fake, clearly non-real secret values embedded with recognizable markers so we
// can assert on their absence in captured output.
const FAKE_DATABASE_URL =
  'postgresql://dbuser:SUPERSECRETDBPASS@ep-fake-host.neon.tech/neondb?sslmode=require';
const FAKE_BLOB_TOKEN =
  'vercel_blob_rw_FAKEStoreId123_SUPERSECRETBLOBTOKENvalue456';

describe('logger secret redaction on processing failure', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Set fake secrets in the environment so the logger's redaction reads them.
    process.env.DATABASE_URL = FAKE_DATABASE_URL;
    process.env.BLOB_READ_WRITE_TOKEN = FAKE_BLOB_TOKEN;

    // Capture everything the logger writes across all console streams.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    delete process.env.DATABASE_URL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
  });

  // Concatenate every captured argument across all console streams into one
  // string so a single assertion can prove neither secret leaked anywhere.
  function capturedOutput(): string {
    const calls = [
      ...errorSpy.mock.calls,
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
    ];
    return calls.map((args) => args.map(String).join(' ')).join('\n');
  }

  it('does not log DATABASE_URL or BLOB_READ_WRITE_TOKEN when a failure error embeds them', () => {
    // A malicious/accidental error whose message echoes BOTH secrets verbatim,
    // e.g. a driver error that printed the connection string and a token.
    const leakyError = new Error(
      `connection failed for ${FAKE_DATABASE_URL} using token ${FAKE_BLOB_TOKEN}`,
    );

    // Simulate the worker logging a processing failure for a job.
    logger.failure(42, 7, 3, 'failed', leakyError);

    const output = capturedOutput();

    // The failure must have been logged (non-empty) ...
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain('job.failure');
    expect(output).toContain('"media_id":42');

    // ... but must contain NEITHER secret value (Requirements 14.3, 14.4).
    expect(output).not.toContain(FAKE_DATABASE_URL);
    expect(output).not.toContain(FAKE_BLOB_TOKEN);
    // The password / token bodies themselves must not appear either.
    expect(output).not.toContain('SUPERSECRETDBPASS');
    expect(output).not.toContain('SUPERSECRETBLOBTOKEN');
    // The redaction placeholder should be present where the secrets were.
    expect(output).toContain('[REDACTED]');
  });

  it('redacts secrets embedded in an arbitrary log line', () => {
    const line = JSON.stringify({
      msg: 'boom',
      db: FAKE_DATABASE_URL,
      blob: FAKE_BLOB_TOKEN,
    });

    const redacted = redactSecrets(line);

    expect(redacted).not.toContain(FAKE_DATABASE_URL);
    expect(redacted).not.toContain(FAKE_BLOB_TOKEN);
    expect(redacted).toContain('[REDACTED]');
  });

  it('describeError keeps a short description and does not expand secrets', () => {
    // describeError only keeps name+message; the emit() redaction pass then
    // scrubs any secret the message carried. Here we confirm describeError does
    // not add secret-bearing fields (stack, arbitrary props).
    const err = new Error('short message');
    const desc = describeError(err);
    expect(desc).toBe('Error: short message');
    expect(desc).not.toContain(FAKE_DATABASE_URL);
    expect(desc).not.toContain(FAKE_BLOB_TOKEN);
  });
});
