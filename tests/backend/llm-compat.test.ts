import { afterEach, expect, it, vi } from 'vitest';
import { complete, extractThread } from '../../lib/llm';
import { endpoint, json } from '../../lib/http';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('uses reasoning-model compatible tokens and leaves unsupported sampling at its default', async () => {
  vi.stubEnv('OPENAI_API_KEY','fixture-only');
  vi.stubEnv('OPENAI_MODEL','gpt-6-luna');
  vi.stubEnv('OPENAI_BASE_URL','https://api.openai.com/v1');
  let sent: Record<string, unknown> = {};
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return Response.json({choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}]});
  });
  expect(await complete('Return JSON','Connectivity test')).toBe('{"ok":true}');
  expect(sent.max_completion_tokens).toBe(6000);
  expect(sent).not.toHaveProperty('max_tokens');
  expect(sent).not.toHaveProperty('temperature');
});
it('shows a safe model-specific error instead of blaming database migrations', async () => {
  vi.stubEnv('OPENAI_API_KEY','private-fixture-key');
  vi.stubEnv('OPENAI_MODEL','test-model');
  vi.stubGlobal('fetch', async () => Response.json({error:{message:'secret provider body private-fixture-key'}}, {status:400}));
  const handler = endpoint(async () => json({answer:await complete('JSON', 'No private data')}));
  const response = await handler(new Request('https://example.test/api/chat'));
  const result = await response.json();
  expect(response.status).toBe(503);
  expect(result.error).toMatch(/model.*request parameters/i);
  expect(result.error).not.toContain('private-fixture-key');
  expect(result.error).not.toContain('secret provider body');
});
it('identifies schema failures safely so a source can retry without hiding its blocker', async () => {
  vi.stubEnv('OPENAI_API_KEY','fixture-only');
  vi.stubEnv('OPENAI_MODEL','test');
  vi.stubGlobal('fetch', async () => Response.json({choices:[{message:{content:JSON.stringify({facts:[{evidence:'PRIVATE-TEST-BODY',kind:'wrong-kind'}]})}}]}));
  let failure: unknown;
  try { await extractThread('PRIVATE-TEST-BODY','2026-11-09T00:00:00Z',[]); } catch (e) { failure=e; }
  expect(failure).toMatchObject({name:'ModelExtractionError',message:expect.stringContaining('schema')});
  expect((failure as Error).message).not.toContain('PRIVATE-TEST-BODY');
  expect((failure as Error).message).not.toContain('fixture-only');
});
