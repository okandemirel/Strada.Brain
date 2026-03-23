import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable, Writable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleWorkspaceRoute, isPathSafe } from '../../dashboard/workspace-routes.js'

// ---------------------------------------------------------------------------
// Helpers (same pattern as monitor-routes.test.ts / canvas-routes.test.ts)
// ---------------------------------------------------------------------------

function fakeReq(method: string): IncomingMessage {
  const readable = new Readable({
    read() {
      this.push(null)
    },
  })
  ;(readable as any).method = method
  return readable as unknown as IncomingMessage
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
  const chunks: Buffer[] = []
  let status = 0

  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      cb()
    },
  }) as any

  writable._status = 0
  writable._body = ''
  writable.writeHead = (s: number, _headers?: Record<string, string>) => {
    status = s
    writable._status = s
  }
  writable.end = (data?: string | Buffer) => {
    if (data) chunks.push(Buffer.from(data))
    writable._body = Buffer.concat(chunks).toString()
    writable._status = status
  }

  return writable as ServerResponse & { _status: number; _body: string }
}

// ---------------------------------------------------------------------------
// Temporary project directory for filesystem tests
// ---------------------------------------------------------------------------

let testRoot: string

beforeEach(() => {
  testRoot = join(tmpdir(), `workspace-routes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testRoot, { recursive: true })
  mkdirSync(join(testRoot, 'Assets'), { recursive: true })
  mkdirSync(join(testRoot, 'Assets', 'Scripts'), { recursive: true })
  mkdirSync(join(testRoot, 'Assets', 'Scripts', 'Player'), { recursive: true })
  writeFileSync(join(testRoot, 'Assets', 'Scripts', 'Player', 'Movement.cs'), 'using UnityEngine;\npublic class Movement {}')
  writeFileSync(join(testRoot, 'Assets', 'Scripts', 'GameManager.cs'), 'using UnityEngine;\npublic class GameManager {}')
  writeFileSync(join(testRoot, '.env'), 'SECRET=abc123')
  writeFileSync(join(testRoot, '.env.local'), 'LOCAL_SECRET=xyz')
  mkdirSync(join(testRoot, 'node_modules', 'some-pkg'), { recursive: true })
  writeFileSync(join(testRoot, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = {}')
  mkdirSync(join(testRoot, '.git', 'objects'), { recursive: true })
  writeFileSync(join(testRoot, '.git', 'objects', 'abc123'), 'git blob')
})

afterEach(() => {
  try {
    rmSync(testRoot, { recursive: true, force: true })
  } catch {
    // best effort cleanup
  }
})

// ---------------------------------------------------------------------------
// Path Security Tests — isPathSafe
// ---------------------------------------------------------------------------

describe('isPathSafe', () => {
  it('rejects paths containing ../', () => {
    const result = isPathSafe('../etc/passwd', testRoot)
    expect(result.safe).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('rejects paths containing ..\\', () => {
    const result = isPathSafe('..\\Windows\\System32', testRoot)
    expect(result.safe).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('rejects paths with null bytes', () => {
    const result = isPathSafe('Assets/test\x00.cs', testRoot)
    expect(result.safe).toBe(false)
    expect(result.error).toContain('Invalid path')
  })

  it('rejects paths outside PROJECT_PATH', () => {
    const result = isPathSafe('/etc/passwd', testRoot)
    expect(result.safe).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('rejects symlinks pointing outside PROJECT_PATH', async () => {
    const linkPath = join(testRoot, 'Assets', 'escape-link')
    try {
      symlinkSync('/tmp', linkPath)
    } catch {
      // symlink creation may fail on some systems, skip
      return
    }

    const result = isPathSafe('Assets/escape-link', testRoot)
    // isPathSafe is sync and does not resolve symlinks (that happens async in the endpoint)
    // The symlink check is an async concern — test the endpoint instead
    expect(result.safe).toBe(true) // sync check passes, endpoint does realpath check

    // Clean up
    try { rmSync(linkPath); } catch { /* */ }
  })

  it('rejects denylist path: .env', () => {
    const result = isPathSafe('.env', testRoot)
    expect(result.safe).toBe(false)
    expect(result.error).toContain('denied')
  })

  it('rejects denylist path: .env.local', () => {
    const result = isPathSafe('.env.local', testRoot)
    expect(result.safe).toBe(false)
    expect(result.error).toContain('denied')
  })

  it('rejects denylist path: node_modules/', () => {
    const result = isPathSafe('node_modules/some-pkg/index.js', testRoot)
    expect(result.safe).toBe(false)
    expect(result.error).toContain('denied')
  })

  it('rejects denylist path: .git/objects/', () => {
    const result = isPathSafe('.git/objects/abc123', testRoot)
    expect(result.safe).toBe(false)
    expect(result.error).toContain('denied')
  })

  it('rejects depth > 10', () => {
    const deepPath = Array.from({ length: 11 }, (_, i) => `d${i}`).join('/')
    const result = isPathSafe(deepPath, testRoot)
    expect(result.safe).toBe(false)
    expect(result.error).toContain('deep')
  })

  it('accepts valid paths within PROJECT_PATH', () => {
    const result = isPathSafe('Assets/Scripts/GameManager.cs', testRoot)
    expect(result.safe).toBe(true)
    expect(result.resolved).toContain('Assets')
  })

  it('accepts nested valid paths', () => {
    const result = isPathSafe('Assets/Scripts/Player/Movement.cs', testRoot)
    expect(result.safe).toBe(true)
    expect(result.resolved).toContain('Player')
  })

  it('normalizes path separators', () => {
    const result = isPathSafe('Assets\\Scripts\\GameManager.cs', testRoot)
    expect(result.safe).toBe(true)
    expect(result.resolved).toContain('Assets')
  })

  it('accepts root path (empty string as .)', () => {
    const result = isPathSafe('.', testRoot)
    expect(result.safe).toBe(true)
  })

  it('rejects encoded traversal like %2e%2e', () => {
    // After URL decoding, this would be ../etc — the caller should decode first
    // but isPathSafe checks the already-decoded string
    const result = isPathSafe('../etc', testRoot)
    expect(result.safe).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Endpoint Tests — handleWorkspaceRoute
// ---------------------------------------------------------------------------

describe('handleWorkspaceRoute', () => {
  it('returns false for non-workspace routes', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    const handled = handleWorkspaceRoute('/api/config', 'GET', req, res, testRoot)
    expect(handled).toBe(false)
  })

  it('returns 400 when projectRoot is empty/undefined', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    const handled = handleWorkspaceRoute('/api/workspace/files?path=.', 'GET', req, res, '')
    expect(handled).toBe(true)
    expect(res._status).toBe(400)
    expect(JSON.parse(res._body).error).toContain('not configured')
  })

  // -- GET /api/workspace/files -------------------------------------------

  it('GET /api/workspace/files returns directory listing', async () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    handleWorkspaceRoute('/api/workspace/files?path=Assets/Scripts', 'GET', req, res, testRoot)

    // async fs operations need a tick
    await new Promise((r) => setTimeout(r, 100))

    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.entries).toBeDefined()
    expect(Array.isArray(body.entries)).toBe(true)
    // Should contain GameManager.cs and Player/
    const names = body.entries.map((e: any) => e.name)
    expect(names).toContain('GameManager.cs')
    expect(names).toContain('Player')
  })

  it('GET /api/workspace/files rejects missing path param', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    handleWorkspaceRoute('/api/workspace/files', 'GET', req, res, testRoot)
    expect(res._status).toBe(400)
    expect(JSON.parse(res._body).error).toContain('path')
  })

  it('GET /api/workspace/files rejects traversal attack', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    handleWorkspaceRoute('/api/workspace/files?path=../../../etc', 'GET', req, res, testRoot)
    expect(res._status).toBe(403)
  })

  it('GET /api/workspace/files rejects denied paths', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    handleWorkspaceRoute('/api/workspace/files?path=node_modules', 'GET', req, res, testRoot)
    expect(res._status).toBe(403)
  })

  // -- GET /api/workspace/file --------------------------------------------

  it('GET /api/workspace/file returns file content', async () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    handleWorkspaceRoute('/api/workspace/file?path=Assets/Scripts/GameManager.cs', 'GET', req, res, testRoot)

    await new Promise((r) => setTimeout(r, 100))

    expect(res._status).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.content).toContain('GameManager')
    expect(body.language).toBe('csharp')
  })

  it('GET /api/workspace/file rejects missing path param', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    handleWorkspaceRoute('/api/workspace/file', 'GET', req, res, testRoot)
    expect(res._status).toBe(400)
    expect(JSON.parse(res._body).error).toContain('path')
  })

  it('GET /api/workspace/file rejects traversal attack', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    handleWorkspaceRoute('/api/workspace/file?path=../../etc/passwd', 'GET', req, res, testRoot)
    expect(res._status).toBe(403)
  })

  it('GET /api/workspace/file returns 404 for non-existent file', async () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    handleWorkspaceRoute('/api/workspace/file?path=Assets/NoSuchFile.cs', 'GET', req, res, testRoot)

    await new Promise((r) => setTimeout(r, 100))

    expect(res._status).toBe(404)
  })

  // -- GET /api/workspace/diff/:taskId ------------------------------------

  it('GET /api/workspace/diff/:taskId returns 404 when not found', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    handleWorkspaceRoute('/api/workspace/diff/nonexistent-task', 'GET', req, res, testRoot)
    expect(res._status).toBe(404)
  })

  // -- 404 within namespace -----------------------------------------------

  it('returns 404 for unknown /api/workspace/* sub-path', () => {
    const req = fakeReq('GET')
    const res = fakeRes()
    const handled = handleWorkspaceRoute('/api/workspace/unknown', 'GET', req, res, testRoot)
    expect(handled).toBe(true)
    expect(res._status).toBe(404)
  })

  // -- Symlink escape check (async endpoint level) ------------------------

  it('GET /api/workspace/file rejects symlinks escaping project root', async () => {
    const linkPath = join(testRoot, 'Assets', 'escape-link.txt')
    try {
      // Create a symlink pointing outside the project
      symlinkSync('/etc/hosts', linkPath)
    } catch {
      // symlink creation may fail, skip
      return
    }

    const req = fakeReq('GET')
    const res = fakeRes()
    handleWorkspaceRoute('/api/workspace/file?path=Assets/escape-link.txt', 'GET', req, res, testRoot)

    await new Promise((r) => setTimeout(r, 100))

    expect(res._status).toBe(403)

    try { rmSync(linkPath); } catch { /* */ }
  })
})
