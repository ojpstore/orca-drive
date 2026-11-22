import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import activate, { authUrl, contentRange, downloadPath, listQuery, searchQuery } from './worker.mjs'
import { EXPORTS, filterTree, googleKind, rangeIds, sortFiles, uniqueName, withExt } from './panel/lib.mjs'

test('listQuery escapes quotes and backslashes', () => {
  assert.equal(listQuery('root'), "'root' in parents and trashed = false")
  assert.equal(listQuery("a'b\\c"), "'a\\'b\\\\c' in parents and trashed = false")
})

test('contentRange', () => {
  assert.equal(contentRange(0, 1024, 3000), 'bytes 0-1023/3000')
  assert.equal(contentRange(2048, 952, 3000), 'bytes 2048-2999/3000')
  assert.equal(contentRange(0, 0, 0), 'bytes */0')
})

test('authUrl carries PKCE, offline access and redirect', () => {
  const u = new URL(authUrl({ clientId: 'cid', redirect: 'http://127.0.0.1:5000/', challenge: 'ch', state: 'st' }))
  assert.equal(u.searchParams.get('client_id'), 'cid')
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:5000/')
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('access_type'), 'offline')
  assert.equal(u.searchParams.get('state'), 'st')
})

test('downloadPath sanitizes and avoids existing names', () => {
  const taken = new Set([join('D', 'a.txt'), join('D', 'a (1).txt')])
  const has = (p) => taken.has(p)
  assert.equal(downloadPath('a.txt', 'D', has), join('D', 'a (2).txt'))
  assert.equal(downloadPath('../x/y:z.md', 'D', has), join('D', '_x_y_z.md'))
  assert.equal(downloadPath('..', 'D', has), join('D', 'download'))
  assert.equal(downloadPath(String.raw`..\..\evil.exe`, 'D', has), join('D', '_.._evil.exe')) // Windows 경로 탈출 방지
  assert.equal(downloadPath('a\u0000b', 'D', has), join('D', 'a_b'))
})

test('searchQuery escapes and searches name and content', () => {
  assert.equal(searchQuery("it's"), String.raw`(name contains 'it\'s' or fullText contains 'it\'s') and trashed = false`)
})

const F = 'application/vnd.google-apps.folder'
const f = (name, extra = {}) => ({ id: name, name, mimeType: 'text/plain', ...extra })
const d = (name) => ({ id: name, name, mimeType: F })

test('sortFiles keeps folders first and sorts by key and direction', () => {
  const files = [f('b.txt', { size: '5', modifiedTime: '2024-01-02' }), d('z'), f('a10.txt', { size: '1', modifiedTime: '2024-01-03' }), f('a9.txt', { size: '9', modifiedTime: '2024-01-01' }), d('y')]
  const names = (k, dir) => sortFiles(files, k, dir).map((x) => x.name).join(' ')
  assert.equal(names('name', 1), 'y z a9.txt a10.txt b.txt') // 숫자는 자연 정렬
  assert.equal(names('name', -1), 'z y b.txt a10.txt a9.txt')
  assert.equal(names('size', -1), 'y z a9.txt b.txt a10.txt')
  assert.equal(names('modified', -1), 'y z a10.txt b.txt a9.txt')
})

test('uniqueName and withExt', () => {
  assert.equal(uniqueName('a.txt', new Set(['a.txt', 'a (1).txt'])), 'a (2).txt')
  assert.equal(uniqueName('folder', new Set(['folder'])), 'folder (1)')
  assert.equal(uniqueName('.env', new Set(['.env'])), '.env (1)')
  assert.equal(withExt('보고서', 'pdf'), '보고서.pdf')
  assert.equal(withExt('data.CSV', 'csv'), 'data.CSV')
})

test('filterTree shows matches and their ancestors only, survives cycles', () => {
  const kids = new Map([
    ['root', [d('docs'), d('pics'), f('readme.md')]],
    ['docs', [f('plan.txt'), d('old')]],
    ['old', [f('Plan-v1.txt'), d('docs')]], // 순환
    ['pics', [f('cat.png')]]
  ])
  assert.deepEqual([...filterTree(kids, 'root', 'plan')].sort(), ['Plan-v1.txt', 'docs', 'old', 'plan.txt'])
  assert.equal(filterTree(kids, 'root', 'zzz').size, 0)
})

test('rangeIds works in both directions', () => {
  const order = ['a', 'b', 'c', 'd']
  assert.deepEqual(rangeIds(order, 'b', 'd'), ['b', 'c', 'd'])
  assert.deepEqual(rangeIds(order, 'd', 'b'), ['b', 'c', 'd'])
  assert.deepEqual(rangeIds(order, 'x', 'c'), ['c'])
})

test('EXPORTS cover Google Docs, Sheets, Slides with office and pdf formats', () => {
  for (const k of ['document', 'spreadsheet', 'presentation']) {
    const exts = EXPORTS[k].map(([, , ext]) => ext)
    assert.ok(exts.includes('pdf'), k)
  }
  assert.ok(EXPORTS.spreadsheet.some(([, , e]) => e === 'csv'))
  assert.equal(googleKind({ mimeType: 'application/vnd.google-apps.spreadsheet' }), 'spreadsheet')
  assert.equal(googleKind({ mimeType: 'text/plain' }), null)
})

test('upload.chunk buffers small pieces into 256 KiB-aligned PUTs', async () => {
  const handlers = {}
  const secrets = { clientId: 'c', clientSecret: 's', refreshToken: 'r' }
  activate({ secrets: { get: async (k) => secrets[k] }, panels: { handle: (n, fn) => (handlers[n] = fn), post() {} } })
  const puts = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('oauth2')) return Response.json({ access_token: 'a', expires_in: 3600 })
    if (init.method === 'POST') return new Response('', { headers: { location: 'S' } })
    puts.push({ range: init.headers['content-range'], len: init.body.length })
    return new Response('', { status: puts.length < 2 ? 308 : 200 })
  }
  try {
    const total = 9 * 1024 * 1024
    const { id } = await handlers['upload.start']({ name: 'x', size: total })
    const piece = Buffer.alloc(40 * 1024).toString('base64')
    let done
    for (let sent = 0; sent < total; sent += 40 * 1024) {
      const n = Math.min(40 * 1024, total - sent)
      ;({ done } = await handlers['upload.chunk']({ id, total, data: n === 40 * 1024 ? piece : Buffer.alloc(n).toString('base64') }))
    }
    assert.equal(done, true)
    assert.deepEqual(puts, [
      { range: `bytes 0-${8 * 1024 * 1024 - 1}/${total}`, len: 8 * 1024 * 1024 },
      { range: `bytes ${8 * 1024 * 1024}-${total - 1}/${total}`, len: 1024 * 1024 }
    ])
  } finally {
    globalThis.fetch = realFetch
  }
})

// fetch를 가짜로 바꿔 worker 핸들러가 보내는 요청을 기록한다.
async function withWorker(respond, run) {
  const handlers = {}
  const secrets = { clientId: 'c', clientSecret: 's', refreshToken: 'r' }
  activate({ secrets: { get: async (k) => secrets[k] }, panels: { handle: (n, fn) => (handlers[n] = fn), post() {} } })
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('oauth2')) return Response.json({ access_token: 'a', expires_in: 3600 })
    calls.push({ url: new URL(url), method: init.method ?? 'GET', body: init.body && JSON.parse(init.body) })
    return respond(calls.at(-1))
  }
  try {
    await run(handlers, calls)
  } finally {
    globalThis.fetch = realFetch
  }
}

test('drive.list maps virtual sections to queries and lists shared drives', async () => {
  await withWorker((c) => Response.json(c.url.pathname.endsWith('/drives') ? { drives: [{ id: 'D1', name: '팀' }] } : { files: [] }), async (h, calls) => {
    await h['drive.list']({ parent: '@starred' })
    assert.equal(calls[0].url.searchParams.get('q'), 'starred = true and trashed = false')
    assert.equal(calls[0].url.searchParams.get('includeItemsFromAllDrives'), 'true')
    assert.equal(calls[0].url.searchParams.get('supportsAllDrives'), 'true')
    await h['drive.list']({ parent: '@trash' })
    assert.equal(calls[1].url.searchParams.get('q'), 'trashed = true')
    await h['drive.list']({ parent: '@recent' })
    assert.equal(calls[2].url.searchParams.get('orderBy'), 'modifiedTime desc')
    assert.equal(calls[2].url.searchParams.get('pageSize'), '50')
    assert.deepEqual((await h['drive.list']({ parent: '@drives' })).files, [{ id: 'D1', name: '팀', mimeType: F }])
    await h['drive.list']({ parent: 'abc' })
    assert.equal(calls.at(-1).url.searchParams.get('q'), "'abc' in parents and trashed = false")
  })
})

test('star, restore, delete', async () => {
  await withWorker(() => new Response(null, { status: 204 }), async (h, calls) => {
    await h['drive.star']({ id: 'x', starred: true })
    await h['drive.restore']({ id: 'x' })
    await h['drive.delete']({ id: 'x' })
    assert.deepEqual(calls.map((c) => [c.method, c.body]), [['PATCH', { starred: true }], ['PATCH', { trashed: false }], ['DELETE', undefined]])
  })
})

test('drive.share creates, updates and removes the anyone-with-link permission', async () => {
  let perms = []
  await withWorker((c) => Response.json(c.method === 'GET' ? { permissions: perms } : {}), async (h, calls) => {
    await h['drive.share']({ id: 'x', role: 'reader' })
    assert.deepEqual([calls[1].method, calls[1].body], ['POST', { type: 'anyone', role: 'reader' }])
    perms = [{ id: 'p1', type: 'anyone', role: 'reader' }, { id: 'p2', type: 'user', role: 'writer' }]
    assert.deepEqual(await h['drive.sharing']({ id: 'x' }), { role: 'reader' })
    await h['drive.share']({ id: 'x', role: 'writer' })
    assert.deepEqual([calls.at(-1).method, calls.at(-1).url.pathname.endsWith('/permissions/p1'), calls.at(-1).body], ['PATCH', true, { role: 'writer' }])
    await h['drive.share']({ id: 'x', role: null })
    assert.deepEqual([calls.at(-1).method, calls.at(-1).url.pathname.endsWith('/permissions/p1')], ['DELETE', true])
  })
})
