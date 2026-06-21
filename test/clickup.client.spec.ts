import { of, throwError } from 'rxjs';
import { ClickupClient } from '../src/clickup/clickup.client';

function build(httpRequest: jest.Mock) {
  const http = { request: httpRequest } as any;
  const workspaces = { getApiToken: () => 'pk_test', getTeamId: () => '3450636' } as any;
  return new ClickupClient(http, workspaces);
}

function err429(retryAfter: string) {
  return { response: { status: 429, headers: { 'retry-after': retryAfter } }, message: 'rate limited' };
}

describe('ClickupClient — 429 / Retry-After handling', () => {
  it('retries after the Retry-After delay and returns the eventual result', async () => {
    const request = jest
      .fn()
      .mockReturnValueOnce(throwError(() => err429('0')))
      .mockReturnValueOnce(of({ data: { id: 'task-1' } }));

    const client = build(request);
    const task = await client.getTask('ws1', 'task-1');

    expect(task).toEqual({ id: 'task-1' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry budget and rethrows the 429', async () => {
    const request = jest.fn().mockReturnValue(throwError(() => err429('0')));
    const client = build(request);

    await expect(client.getTask('ws1', 'task-1')).rejects.toMatchObject({ response: { status: 429 } });
    // initial attempt + bounded retries (does not loop forever)
    expect(request.mock.calls.length).toBeGreaterThan(1);
    expect(request.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('does not retry non-429 errors', async () => {
    const request = jest
      .fn()
      .mockReturnValue(throwError(() => ({ response: { status: 500 }, message: 'server error' })));
    const client = build(request);

    await expect(client.getTask('ws1', 'task-1')).rejects.toMatchObject({ response: { status: 500 } });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

function urlOf(call: any[]): string {
  return call[0].url as string;
}

function windowOf(url: string): { start: number; end: number } {
  const qs = new URLSearchParams(url.split('?')[1]);
  return { start: Number(qs.get('start_date')), end: Number(qs.get('end_date')) };
}

describe('ClickupClient.getTimeEntries — multi-year window chunking', () => {
  it('sends a single request when the window is within one year', async () => {
    const request = jest.fn().mockReturnValue(of({ data: { data: [{ id: 'e1' }] } }));
    const client = build(request);

    const end = Date.now();
    const start = end - 300 * DAY_MS; // < 365 days
    const entries = await client.getTimeEntries('ws1', 'task-1', { startDate: start, endDate: end });

    expect(request).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1);
    const win = windowOf(urlOf(request.mock.calls[0]));
    expect(win.start).toBe(start);
    expect(win.end).toBe(end);
  });

  it('splits a 3-year window into yearly slices covering the full range without gaps', async () => {
    const request = jest.fn().mockReturnValue(of({ data: { data: [] } }));
    const client = build(request);

    const end = Date.now();
    const start = end - 1095 * DAY_MS; // exactly 3 years
    await client.getTimeEntries('ws1', 'task-1', { startDate: start, endDate: end });

    expect(request).toHaveBeenCalledTimes(3);
    const wins = request.mock.calls.map((c) => windowOf(urlOf(c))).sort((a, b) => a.start - b.start);
    // first slice starts at the window start, last slice ends at the window end
    expect(wins[0].start).toBe(start);
    expect(wins[wins.length - 1].end).toBe(end);
    // contiguous, non-overlapping slices
    for (let i = 1; i < wins.length; i++) {
      expect(wins[i].start).toBe(wins[i - 1].end);
    }
  });

  it('dedupes entries that appear in more than one slice', async () => {
    const request = jest
      .fn()
      .mockReturnValueOnce(of({ data: { data: [{ id: 'e1' }, { id: 'shared' }] } }))
      .mockReturnValueOnce(of({ data: { data: [{ id: 'shared' }, { id: 'e2' }] } }))
      .mockReturnValueOnce(of({ data: { data: [{ id: 'e3' }] } }));
    const client = build(request);

    const end = Date.now();
    const start = end - 1095 * DAY_MS;
    const entries = await client.getTimeEntries('ws1', 'task-1', { startDate: start, endDate: end });

    const ids = entries.map((e: any) => e.id).sort();
    expect(ids).toEqual(['e1', 'e2', 'e3', 'shared']);
  });
});

describe('ClickupClient.getAllTasksBySpace — truncation signal', () => {
  it('returns the tasks plus truncated=false when pagination ends on a short page', async () => {
    // One full page (100) then a short page (1) → normal end, not truncated.
    const fullPage = { tasks: Array.from({ length: 100 }, (_, i) => ({ id: `t${i}` })) };
    const shortPage = { tasks: [{ id: 'last' }] };
    const request = jest
      .fn()
      .mockReturnValueOnce(of({ data: fullPage }))
      .mockReturnValueOnce(of({ data: shortPage }));
    const client = build(request);

    const res = await client.getAllTasksBySpace('ws1', '3577824', {});

    expect(res.truncated).toBe(false);
    expect(res.tasks).toHaveLength(101);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
