import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'

const port = Number.parseInt(process.argv[2] ?? '4173', 10)
const workspaceRoot = resolve(import.meta.dirname, '..')
const root = process.argv[3]
  ? resolve(workspaceRoot, process.argv[3])
  : resolve(workspaceRoot, 'apps/client/dist/h5')

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`无效端口：${process.argv[2] ?? ''}`)
}

if (!existsSync(resolve(root, 'index.html'))) {
  throw new Error(`未找到 H5 产物：${root}。请先运行 pnpm build:h5。`)
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
  let pathname
  try {
    pathname = decodeURIComponent(requestUrl.pathname)
  } catch {
    response.writeHead(400).end('Bad Request')
    return
  }

  const candidate = resolve(root, `.${pathname}`)
  const insideRoot = candidate === root || candidate.startsWith(`${root}${sep}`)
  if (!insideRoot) {
    response.writeHead(403).end('Forbidden')
    return
  }

  let file = candidate
  if (existsSync(file) && statSync(file).isDirectory()) file = resolve(file, 'index.html')
  if (!existsSync(file) || !statSync(file).isFile()) {
    const acceptsHtml = (request.headers.accept ?? '').toLowerCase().includes('text/html')
    const lastSegment = pathname.split('/').at(-1) ?? ''
    if (acceptsHtml && !lastSegment.includes('.')) file = resolve(root, 'index.html')
    else {
      response.writeHead(404, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      }).end('Not Found')
      return
    }
  }

  response.writeHead(200, {
    'Cache-Control': file.endsWith(`${sep}index.html`) || file.endsWith(`${sep}sw.js`)
      ? 'no-cache, no-store, must-revalidate'
      : 'public, max-age=0, must-revalidate',
    'Content-Type': mimeTypes[extname(file).toLowerCase()] ?? 'application/octet-stream',
  })
  createReadStream(file).pipe(response)
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`H5 test server listening at http://127.0.0.1:${port}\n`)
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
