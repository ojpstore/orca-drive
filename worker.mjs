// Google Drive REST v3 호출과 OAuth 로그인을 맡는다. 패널은 네트워크·소켓을 못 쓰므로 worker가 한다.
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, parse } from 'node:path'
import tls from 'node:tls'

// 회사 TLS 검사(예: Somansa)의 루트 CA는 OS 인증서 저장소에만 있고, Orca worker엔 NODE_EXTRA_CA_CERTS도 안 넘어온다.
tls.setDefaultCACertificates?.([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])

const API = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
const TOKEN = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/drive'
export const FOLDER = 'application/vnd.google-apps.folder'
const FIELDS = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,parents)'

// Drive 검색식의 문자열 리터럴은 ' 와 \ 를 \ 로 이스케이프한다.
const lit = (v) => `'${String(v).replace(/['\\]/g, '\\$&')}'`
export const listQuery = (parent) => `${lit(parent)} in parents and trashed = false`
// 이름 또는 본문에 text가 들어간 파일(휴지통 제외).
export const searchQuery = (text) => `(name contains ${lit(text)} or fullText contains ${lit(text)}) and trashed = false`

export function authUrl({ clientId, redirect, challenge, state }) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline', // refresh token을 받는다
    prompt: 'consent' // 다시 로그인해도 refresh token을 새로 준다
  })
  return u.href
}

// 재개 가능 업로드의 Content-Range. 빈 파일은 'bytes */0'.
export const contentRange = (offset, length, total) =>
  length ? `bytes ${offset}-${offset + length - 1}/${total}` : `bytes */${total}`

// 다운로드 폴더 안의 저장 경로. 경로 문자는 _ 로 바꾸고, 같은 이름이 있으면 'a (1).txt' 식으로 피한다.
export function downloadPath(name, dir = join(homedir(), 'Downloads'), exists = existsSync) {
  const safe = String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '') || 'download'
  const { name: base, ext } = parse(safe)
  let p = join(dir, safe)
  for (let i = 1; exists(p); i++) p = join(dir, `${base} (${i})${ext}`)
  return p
}

// OS 기본 프로그램으로 연다.
function openPath(p) {
  const [cmd, args] =
    process.platform === 'win32' ? ['explorer.exe', [p]] : process.platform === 'darwin' ? ['open', [p]] : ['xdg-open', [p]]
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
}

const b64url = (buf) => buf.toString('base64url')

let login = null // 진행 중인 로그인 서버

export function deactivate() {
  login?.close()
}

export default function activate(orca) {
  let token = null // { access, exp }
  const uploads = new Map() // id -> 재개 가능 업로드 세션 URL

  const secret = (k) => orca.secrets.get(k)
  // 입력 없이 불려도(null) 구조 분해가 깨지지 않게.
  const on = (name, fn) => orca.panels.handle(name, (input) => fn(input ?? {}))

  async function tokenRequest(body) {
    const res = await fetch(TOKEN, { method: 'POST', body: new URLSearchParams(body) })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error_description || json.error || `token ${res.status}`)
    token = { access: json.access_token, exp: Date.now() + json.expires_in * 1000 }
    return json
  }

  async function accessToken() {
    if (token && token.exp > Date.now() + 60_000) return token.access
    const [client_id, client_secret, refresh_token] = await Promise.all(['clientId', 'clientSecret', 'refreshToken'].map(secret))
    if (!refresh_token) throw new Error('로그인이 필요합니다')
    try {
      await tokenRequest({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' })
    } catch (e) {
      // 토큰이 취소·만료됐으면 지워서 패널이 다시 로그인 화면을 보이게 한다.
      if (/invalid_grant|expired|revoked/i.test(e.message)) {
        await orca.secrets.delete('refreshToken')
        orca.panels.post('auth.changed', {})
      }
      throw e
    }
    return token.access
  }

  async function api(url, init = {}) {
    const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${await accessToken()}`, ...init.headers } })
    if (res.status === 204) return null
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error?.message || `Drive ${res.status}`)
    return json
  }
  const jsonInit = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  on('auth.status', async () => ({
    configured: !!(await secret('clientId')),
    signedIn: !!(await secret('refreshToken'))
  }))

  on('auth.config', async ({ clientId, clientSecret }) => {
    if (!clientId?.trim() || !clientSecret?.trim()) throw new Error('Client ID와 Client secret을 모두 넣으세요')
    await orca.secrets.set('clientId', clientId.trim())
    await orca.secrets.set('clientSecret', clientSecret.trim())
    return {}
  })

  // 127.0.0.1 임의 포트에 리디렉션 받을 서버를 띄우고, 브라우저에서 열 주소를 돌려준다.
  on('auth.begin', async () => {
    const clientId = await secret('clientId')
    if (!clientId) throw new Error('Client ID를 먼저 설정하세요')
    login?.close()
    const verifier = b64url(randomBytes(32))
    const state = b64url(randomBytes(16))
    const server = (login = createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      if (u.pathname !== '/') return res.writeHead(404).end()
      let msg = '로그인 완료. Orca로 돌아가세요.'
      try {
        if (u.searchParams.get('state') !== state) throw new Error('state가 맞지 않습니다')
        if (u.searchParams.get('error')) throw new Error(u.searchParams.get('error'))
        const json = await tokenRequest({
          client_id: clientId,
          client_secret: await secret('clientSecret'),
          code: u.searchParams.get('code'),
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: redirect
        })
        if (json.refresh_token) await orca.secrets.set('refreshToken', json.refresh_token)
      } catch (e) {
        msg = `로그인 실패: ${e.message}${e.cause ? ` (${e.cause.code ?? ''} ${e.cause.message ?? e.cause})` : ''}`
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(msg)
      server.close()
      if (login === server) login = null
      orca.panels.post('auth.changed', {})
    }))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const redirect = `http://127.0.0.1:${server.address().port}/`
    setTimeout(() => server.close(), 5 * 60_000).unref()
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    return { url: authUrl({ clientId, redirect, challenge, state }) }
  })

  on('auth.signOut', async () => {
    const t = await secret('refreshToken')
    await orca.secrets.delete('refreshToken')
    token = null
    if (t) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' }).catch(() => {})
    return {}
  })

  on('drive.about', async () => ({ email: (await api('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)')).user.emailAddress }))

  on('drive.list', async ({ parent = 'root' }) => {
    const files = []
    let pageToken = ''
    do {
      const q = new URLSearchParams({ q: listQuery(parent), fields: FIELDS, orderBy: 'folder,name', pageSize: '1000' })
      if (pageToken) q.set('pageToken', pageToken)
      const r = await api(`${API}?${q}`)
      files.push(...r.files)
      pageToken = r.nextPageToken
    } while (pageToken)
    return { files }
  })

  // 다운로드는 백그라운드 작업이다(패널 요청 120초 제한을 넘는 큰 파일도 받게).
  // 진행률은 'download.progress', 끝은 'download.done' / 'download.error' 이벤트로 알린다.
  // exportMime이 있으면 Google 문서를 그 형식으로 변환해 받는다.
  const jobs = new Map() // job -> AbortController
  on('download.start', async ({ id, name, exportMime, open = true }) => {
    const job = b64url(randomBytes(9))
    const ac = new AbortController()
    jobs.set(job, ac)
    const url = exportMime
      ? `${API}/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportMime)}`
      : `${API}/${encodeURIComponent(id)}?alt=media`
    const run = async () => {
      let path
      try {
        const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` }, signal: ac.signal })
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || `download ${res.status}`)
        const total = Number(res.headers.get('content-length')) || 0
        path = downloadPath(name)
        const out = createWriteStream(path, { flags: 'wx' })
        let received = 0
        let last = 0
        try {
          for await (const chunk of res.body) {
            if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
            received += chunk.length
            if (Date.now() - last > 250) {
              last = Date.now()
              orca.panels.post('download.progress', { job, received, total })
            }
          }
        } finally {
          await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())))
        }
        if (open) openPath(path)
        orca.panels.post('download.done', { job, path })
      } catch (e) {
        if (path) await unlink(path).catch(() => {}) // 반쯤 받은 파일은 지운다
        orca.panels.post('download.error', { job, cancelled: ac.signal.aborted, message: e.message })
      } finally {
        jobs.delete(job)
      }
    }
    run()
    return { job }
  })

  on('download.cancel', ({ job }) => {
    jobs.get(job)?.abort()
    return {}
  })

  on('drive.search', async ({ text }) => {
    const q = new URLSearchParams({ q: searchQuery(text), fields: FIELDS, pageSize: '200' })
    return { files: (await api(`${API}?${q}`)).files }
  })

  on('drive.rename', ({ id, name }) => api(`${API}/${encodeURIComponent(id)}?fields=id`, jsonInit('PATCH', { name })))

  on('drive.copy', ({ id, name }) => api(`${API}/${encodeURIComponent(id)}/copy?fields=id`, jsonInit('POST', { name })))

  on('drive.mkdir', ({ parent = 'root', name }) =>
    api(`${API}?fields=id`, jsonInit('POST', { name, mimeType: FOLDER, parents: [parent] })))

  // 휴지통으로 보낸다(30일 안에 Drive에서 복구 가능).
  on('drive.trash', ({ id }) => api(`${API}/${encodeURIComponent(id)}?fields=id`, jsonInit('PATCH', { trashed: true })))

  on('drive.move', ({ id, from, to }) => {
    const q = new URLSearchParams({ addParents: to, removeParents: from, fields: 'id' })
    return api(`${API}/${encodeURIComponent(id)}?${q}`, jsonInit('PATCH', {}))
  })

  // replaceId가 있으면 그 파일의 새 버전으로 올린다(이름·위치·공유 유지).
  on('upload.start', async ({ parent = 'root', name, mimeType, size, replaceId }) => {
    const url = replaceId ? `${UPLOAD}/${encodeURIComponent(replaceId)}` : UPLOAD
    const res = await fetch(`${url}?uploadType=resumable&fields=id`, {
      method: replaceId ? 'PATCH' : 'POST',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(size),
        ...(mimeType && { 'x-upload-content-type': mimeType })
      },
      body: JSON.stringify(replaceId ? {} : { name, parents: [parent] })
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || `upload ${res.status}`)
    const id = b64url(randomBytes(9))
    uploads.set(id, res.headers.get('location'))
    return { id }
  })

  // 한 조각(base64)을 올린다. 308 = 계속, 200/201 = 끝.
  on('upload.chunk', async ({ id, offset, total, data }) => {
    const session = uploads.get(id)
    if (!session) throw new Error('업로드 세션이 없습니다')
    const body = Buffer.from(data, 'base64')
    const res = await fetch(session, { method: 'PUT', headers: { 'content-range': contentRange(offset, body.length, total) }, body })
    if (res.status === 308) return { done: false }
    uploads.delete(id)
    if (!res.ok) throw new Error(`upload ${res.status}: ${await res.text()}`)
    return { done: true }
  })

  // 업로드 취소: 세션을 지우면 Drive가 받은 조각을 버린다.
  on('upload.cancel', async ({ id }) => {
    const session = uploads.get(id)
    uploads.delete(id)
    if (session) await fetch(session, { method: 'DELETE' }).catch(() => {})
    return {}
  })
}
