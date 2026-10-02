import { afterEach, expect, it, vi } from 'vitest';
import { sendEmail } from './mailer';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('passes the optional provider idempotency header without changing the email body', async () => {
  vi.stubEnv('RESEND_API_KEY', 'test-only');
  const fetcher = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetcher);
  const args = { to: 'test@example.test', subject: 'test', text: 'test', html: '<p>test</p>' };
  await sendEmail({ ...args, idempotencyKey: 'credit-note/test' });
  expect(fetcher.mock.calls[0][1].headers['Idempotency-Key']).toBe('credit-note/test');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).not.toHaveProperty('idempotencyKey');
  await sendEmail(args);
  expect(fetcher.mock.calls[1][1].headers).not.toHaveProperty('Idempotency-Key');
});
