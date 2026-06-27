import { of } from 'rxjs';
import { ClickupClient } from '../src/clickup/clickup.client';

// Minimal http seam: ClickupClient.request() does
// firstValueFrom(this.http.request(...)).data, so each mock call returns
// of({ data: <body> }). getTaskComments only needs getApiToken (no getTeamId).
function makeClient(pages: any[]) {
  const request = jest.fn();
  for (const body of pages) request.mockReturnValueOnce(of({ data: body }));
  const http = { request } as any;
  const workspaces = { getApiToken: jest.fn().mockReturnValue('pk_token'), getTeamId: jest.fn() } as any;
  return { client: new ClickupClient(http, workspaces), request, workspaces };
}

function page(n: number, startDate: number) {
  // n comments, dated sequentially descending (newest-first), ids c<start>..
  return {
    comments: Array.from({ length: n }, (_, i) => ({
      id: `c${startDate - i}`,
      comment_text: `body ${startDate - i}`,
      date: String(startDate - i),
    })),
  };
}

describe('ClickupClient.getTaskComments', () => {
  it('walks backward pages via start + start_id until a short page, concatenating', async () => {
    // Page 1: full 25 → continue. Page 2: 3 → stop.
    const { client, request } = makeClient([page(25, 1000), page(3, 975)]);
    const comments = await client.getTaskComments('ws1', 'task1');

    expect(comments).toHaveLength(28);
    expect(request).toHaveBeenCalledTimes(2);

    // First call: no cursor params.
    const firstUrl = request.mock.calls[0][0].url as string;
    expect(firstUrl).toContain('/task/task1/comment');
    expect(firstUrl).not.toContain('start=');
    expect(firstUrl).not.toContain('start_id=');

    // Second call: cursor = last comment of page 1 (date 976, id c976).
    const secondUrl = request.mock.calls[1][0].url as string;
    expect(secondUrl).toContain('start=976');
    expect(secondUrl).toContain('start_id=c976');
  });

  it('stops on the first short page (single request) and on an empty page', async () => {
    const short = await makeClient([page(10, 500)]);
    expect(await short.client.getTaskComments('ws1', 't')).toHaveLength(10);
    expect(short.request).toHaveBeenCalledTimes(1);

    const empty = await makeClient([{ comments: [] }]);
    expect(await empty.client.getTaskComments('ws1', 't')).toEqual([]);
    expect(empty.request).toHaveBeenCalledTimes(1);
  });

  it('dedupes a boundary comment repeated across pages', async () => {
    // Page 2 repeats the last id of page 1 (cursor overlap).
    const p1 = page(25, 1000);
    const p2 = { comments: [{ id: 'c976', comment_text: 'dup', date: '976' }, { id: 'c975', comment_text: 'x', date: '975' }] };
    const { client } = makeClient([p1, p2]);
    const comments = await client.getTaskComments('ws1', 't');
    const ids = comments.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toContain('c976');
    expect(ids).toContain('c975');
  });
});
