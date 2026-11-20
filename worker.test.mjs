import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authUrl, contentRange, listQuery } from './worker.mjs'

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
