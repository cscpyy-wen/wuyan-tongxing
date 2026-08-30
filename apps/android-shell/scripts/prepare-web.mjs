import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const shellRoot = resolve(scriptDir, '..')
const repositoryRoot = resolve(shellRoot, '..', '..')
const sourceRoot = resolve(repositoryRoot, 'deploy', 'tencent-cloudbase', 'dist')
const targetRoot = resolve(shellRoot, 'www')

if (relative(shellRoot, targetRoot).startsWith('..')) throw new Error('Android Web 目标越界')

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const pathname = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(pathname))
    else if (entry.isFile()) files.push(pathname)
  }
  return files
}

function exactInlineScriptCsp(index) {
  const inlineHashes = [...index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)]
    .filter((match) => !/\bsrc\s*=/iu.test(match[1] ?? ''))
    .map((match) => `'sha256-${createHash('sha256').update(match[2] ?? '', 'utf8').digest('base64')}'`)
  const cspPattern = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]+)("\s*\/?>)/iu
  const matched = cspPattern.exec(index)
  if (!matched) throw new Error('Android 入口缺少可重写的 CSP meta')
  const directives = matched[2].split(';').map((directive) => directive.trim()).filter(Boolean)
  const scriptIndex = directives.findIndex((directive) => /^script-src\s/iu.test(directive))
  if (scriptIndex < 0) throw new Error('Android CSP 缺少 script-src')
  const baseTokens = directives[scriptIndex].split(/\s+/u).filter((token) => !/^'sha256-/u.test(token))
  directives[scriptIndex] = [...baseTokens, ...new Set(inlineHashes)].join(' ')
  return index.replace(cspPattern, `$1${directives.join('; ')}$3`)
}

const sourceIndex = await readFile(resolve(sourceRoot, 'index.html'), 'utf8')
const offlineRegistration = /<script data-wuyan-offline>[\s\S]*?<\/script>/
if (!offlineRegistration.test(sourceIndex)) throw new Error('未找到待移除的 Service Worker 注册脚本')

const androidBootstrap = [
  '<style data-wuyan-bootstrap-style>',
  '#wuyan-android-bootstrap [hidden]{display:none!important}',
  '.wuyan-bootstrap-card{margin-top:28px;padding:24px;border:1px solid #d9e8e1;border-radius:20px;background:#fff}',
  '.wuyan-bootstrap-count{display:block;margin-bottom:18px;color:#53625c;font-size:16px;text-align:center}',
  '.wuyan-bootstrap-primary{display:flex;width:100%;min-height:72px;align-items:center;justify-content:center;border:0;border-radius:22px;color:#fff;background:#b63f32;font-size:21px;font-weight:750}',
  '.wuyan-bootstrap-sheet{position:fixed;inset:0;z-index:2147483600;display:flex;box-sizing:border-box;padding:24px;align-items:flex-end;background:rgba(15,35,28,.38)}',
  '.wuyan-bootstrap-dialog{width:100%;max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow:auto;box-sizing:border-box;padding:20px;border-radius:24px;background:#fff}',
  '.wuyan-bootstrap-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
  '.wuyan-bootstrap-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-top:12px}',
  '.wuyan-bootstrap-strength{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:12px 0 18px}',
  '.wuyan-bootstrap-choice{min-height:48px;border:1px solid #d9e3df;border-radius:14px;color:#2f3d37;background:#fff;font-size:16px}',
  '.wuyan-bootstrap-choice--selected{border-color:#176b55;color:#0f513f;background:#dcefe7;font-weight:700}',
  '.wuyan-bootstrap-close{min-width:48px;min-height:48px;border:0;border-radius:14px;color:#53625c;background:#edf4f0;font-size:20px}',
  '.wuyan-bootstrap-label{display:block;margin-top:16px;color:#17251f;font-size:16px;font-weight:700}',
  '.wuyan-bootstrap-error{display:block;margin-bottom:10px;color:#a8382d;font-size:14px;text-align:center}',
  '</style>',
  '<main id="wuyan-android-bootstrap" data-wuyan-android-bootstrap ',
  'style="position:fixed;inset:0;z-index:2147483000;box-sizing:border-box;min-height:100vh;height:100vh;height:100dvh;padding:28px 24px;padding:calc(env(safe-area-inset-top) + 28px) 24px 28px;color:#102a22;background:#f8faf8;font-family:sans-serif">',
  '<div id="wuyan-bootstrap-background">',
  '<div style="display:flex;align-items:center;justify-content:space-between">',
  '<strong style="font-size:28px;line-height:1.2">今天</strong>',
  '<a href="#/pages/sos/index" style="display:flex;min-width:88px;min-height:48px;align-items:center;justify-content:center;border:1px solid #e9b7af;border-radius:16px;color:#a8382d;background:#fff8f6;font-size:18px;font-weight:700;text-decoration:none">急救</a>',
  '</div>',
  '<div id="wuyan-bootstrap-loading" class="wuyan-bootstrap-card" role="status" aria-label="正在读取本机记录">',
  '<strong style="display:block;font-size:20px">正在读取本机记录</strong>',
  '<span style="display:block;margin-top:8px;color:#60716a;font-size:15px">无需联网</span>',
  '</div>',
  '<section id="wuyan-bootstrap-ready" class="wuyan-bootstrap-card" hidden>',
  '<span id="wuyan-bootstrap-count" class="wuyan-bootstrap-count" role="status" aria-live="polite" aria-atomic="true">今日 0 支</span>',
  '<button id="wuyan-bootstrap-begin" class="wuyan-bootstrap-primary" type="button">＋&nbsp; 我吸了一支烟</button>',
  '</section>',
  '</div>',
  '<div id="wuyan-bootstrap-sheet" class="wuyan-bootstrap-sheet" hidden>',
  '<section class="wuyan-bootstrap-dialog" role="dialog" aria-modal="true" aria-labelledby="wuyan-bootstrap-dialog-title">',
  '<div class="wuyan-bootstrap-row"><strong id="wuyan-bootstrap-dialog-title" style="font-size:21px">记录这支烟</strong><button id="wuyan-bootstrap-cancel" class="wuyan-bootstrap-close" type="button" aria-label="取消记录">×</button></div>',
  '<span id="wuyan-bootstrap-trigger-label" class="wuyan-bootstrap-label">原因</span>',
  '<div class="wuyan-bootstrap-grid" role="group" aria-labelledby="wuyan-bootstrap-trigger-label">',
  '<button class="wuyan-bootstrap-choice" type="button" data-wuyan-trigger="work" aria-pressed="false">工作疲惫</button>',
  '<button class="wuyan-bootstrap-choice" type="button" data-wuyan-trigger="meal" aria-pressed="false">饭后</button>',
  '<button class="wuyan-bootstrap-choice" type="button" data-wuyan-trigger="toilet" aria-pressed="false">拉屎</button>',
  '<button class="wuyan-bootstrap-choice" type="button" data-wuyan-trigger="stress" aria-pressed="false">压力</button>',
  '<button class="wuyan-bootstrap-choice" type="button" data-wuyan-trigger="social" aria-pressed="false">社交</button>',
  '<button class="wuyan-bootstrap-choice" type="button" data-wuyan-trigger="alcohol" aria-pressed="false">饮酒</button>',
  '<button class="wuyan-bootstrap-choice" type="button" data-wuyan-trigger="exercise" aria-pressed="false">运动后</button>',
  '<button class="wuyan-bootstrap-choice" type="button" data-wuyan-trigger="boredom" aria-pressed="false">无聊</button>',
  '<button class="wuyan-bootstrap-choice" type="button" data-wuyan-trigger="morning" aria-pressed="false">晨起</button>',
  '<button class="wuyan-bootstrap-choice" type="button" data-wuyan-trigger="coffee" aria-pressed="false">咖啡</button>',
  '<button class="wuyan-bootstrap-choice" type="button" data-wuyan-trigger="habit" aria-pressed="false">习惯</button>',
  '</div>',
  '<span id="wuyan-bootstrap-intensity-label" class="wuyan-bootstrap-label">烟瘾强度</span>',
  '<div class="wuyan-bootstrap-strength" role="group" aria-labelledby="wuyan-bootstrap-intensity-label">',
  ...[1, 2, 3, 4, 5].map((level) => `<button class="wuyan-bootstrap-choice" type="button" data-wuyan-intensity="${level}" aria-label="烟瘾强度 ${level}" aria-pressed="false">${level}</button>`),
  '</div>',
  '<span id="wuyan-bootstrap-error" class="wuyan-bootstrap-error" role="alert" hidden></span>',
  '<button id="wuyan-bootstrap-save" class="wuyan-bootstrap-primary" type="button" disabled>保存</button>',
  '</section>',
  '</div>',
  '</main>',
  '<div id="app"></div>',
].join('')

await rm(targetRoot, { recursive: true, force: true })
await mkdir(targetRoot, { recursive: true })

const sourceFiles = await listFiles(sourceRoot)
for (const source of sourceFiles) {
  const pathname = relative(sourceRoot, source).split(sep).join('/')
  if (pathname === 'sw.js') continue
  const destination = resolve(targetRoot, pathname)
  await mkdir(dirname(destination), { recursive: true })
  if (pathname === 'index.html') {
    const transformedIndex = sourceIndex
      .replace(offlineRegistration, '')
      .replace('<meta charset="utf-8"/>', '<meta charset="utf-8"/><meta name="wuyan-runtime" content="android-local"/>')
      .replace('</title>', '</title><script defer src="/android-bootstrap-runtime.js"></script>')
      .replace('<div id="app"></div>', androidBootstrap)
    const index = exactInlineScriptCsp(transformedIndex)
    if (!index.includes('data-wuyan-android-bootstrap')) throw new Error('Android 启动骨架注入失败')
    await writeFile(destination, index, 'utf8')
  } else {
    await cp(source, destination)
  }
}

await cp(resolve(scriptDir, 'android-bootstrap-runtime.js'), resolve(targetRoot, 'android-bootstrap-runtime.js'))

const packagedFiles = await listFiles(targetRoot)
const manifest = []
for (const file of packagedFiles) {
  const pathname = relative(targetRoot, file).split(sep).join('/')
  const body = await readFile(file)
  manifest.push({
    pathname,
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  })
}
await writeFile(resolve(targetRoot, 'android-assets.json'), `${JSON.stringify({
  format: 1,
  runtime: 'capacitor-android-local',
  serviceWorker: false,
  files: manifest,
}, null, 2)}\n`, 'utf8')

console.log(`Android 本地 Web 资源已生成：${manifest.length} 个应用文件，无 Service Worker`)
