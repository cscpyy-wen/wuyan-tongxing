'use strict'

const { spawn } = require('node:child_process')
const { isAbsolute } = require('node:path')

const HTTPS_REMOTE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]+(?:\.git)?$/
const SSH_REMOTE = /^ssh:\/\/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]+(?:\.git)?$/
const SCP_REMOTE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~!$&'()*+,;=@%\/-]+(?:\.git)?$/
const SAFE_REF = /^(?!-)(?!.*[\u0000-\u001f\u007f ~^:?*\\])(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._\/-]+$/

function validateRemote(remote) {
  if (typeof remote !== 'string' || remote.length > 2048) return false
  return HTTPS_REMOTE.test(remote) || SSH_REMOTE.test(remote) || SCP_REMOTE.test(remote)
}

function validateRef(ref) {
  return typeof ref === 'string' && ref.length <= 255 && SAFE_REF.test(ref)
}

function validateGitExecutable(executable) {
  return executable === 'git' || (
    typeof executable === 'string'
    && executable.length <= 1024
    && !/[\u0000-\u001f\u007f]/.test(executable)
    && isAbsolute(executable)
  )
}

module.exports = function clone(remote, targetPath, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = undefined
  }
  const settings = options || {}
  const done = typeof callback === 'function' ? callback : () => undefined
  let completed = false
  const finish = (error) => {
    if (completed) return
    completed = true
    done(error)
  }

  if (!validateRemote(remote)) {
    queueMicrotask(() => finish(new Error('Refusing an unsupported or unsafe git remote')))
    return
  }
  if (typeof targetPath !== 'string' || targetPath.length === 0 || targetPath.length > 4096 || /\u0000/.test(targetPath)) {
    queueMicrotask(() => finish(new Error('Invalid git clone target path')))
    return
  }
  if (settings.checkout != null && !validateRef(settings.checkout)) {
    queueMicrotask(() => finish(new Error('Refusing an unsafe git checkout ref')))
    return
  }
  const executable = settings.git || 'git'
  if (!validateGitExecutable(executable)) {
    queueMicrotask(() => finish(new Error('Refusing an unsafe git executable')))
    return
  }

  const cloneArguments = ['clone']
  if (settings.shallow) cloneArguments.push('--depth', '1')
  cloneArguments.push('--', remote, targetPath)

  let child
  try {
    child = spawn(executable, cloneArguments, { shell: false, windowsHide: true })
  } catch (error) {
    queueMicrotask(() => finish(error))
    return
  }
  child.once('error', finish)
  child.once('close', (status, signal) => {
    if (status !== 0) {
      finish(new Error(`'git clone' failed with status ${status ?? signal ?? 'unknown'}`))
      return
    }
    if (!settings.checkout) {
      finish()
      return
    }

    let checkout
    try {
      checkout = spawn(executable, ['checkout', '--', settings.checkout], {
        cwd: targetPath,
        shell: false,
        windowsHide: true,
      })
    } catch (error) {
      finish(error)
      return
    }
    checkout.once('error', finish)
    checkout.once('close', (checkoutStatus, checkoutSignal) => {
      if (checkoutStatus === 0) finish()
      else finish(new Error(`'git checkout' failed with status ${checkoutStatus ?? checkoutSignal ?? 'unknown'}`))
    })
  })
}

module.exports.validateRemote = validateRemote
module.exports.validateRef = validateRef
