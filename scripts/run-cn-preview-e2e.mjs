import { spawn } from 'node:child_process'

const pnpmCli = process.env.npm_execpath
if (!pnpmCli) throw new Error('请通过 pnpm test:e2e:cn-preview 运行此脚本')
const child = spawn(process.execPath, [pnpmCli, 'exec', 'playwright', 'test'], {
  env: {
    ...process.env,
    WUYAN_E2E_PORT: '4174',
    WUYAN_E2E_ROOT: 'deploy/tencent-cloudbase/dist',
  },
  stdio: 'inherit',
  windowsHide: true,
})

child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`CloudBase E2E 被信号中止：${signal}`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
