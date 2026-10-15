import type { Register } from 'claude-code'

const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase()
const probability = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1
const percent = (p: unknown) => probability(p) ? ` ${Math.round(p * 100)}%` : ''

export const register: Register = (on, options) => {
  const pythonPath = String(options.pythonPath || 'python')
  const routerScript = String(options.routerScript || '').trim()
  const privateFolders = String(options.privateFolders || '').split(',').map(s => s.trim()).filter(Boolean).map(normalize)
  const privateWords = String(options.privateWords || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  let sequence = 0

  on('prompt.submit', ($, e, next) => {
    const current = ++sequence
    $.ui.status(undefined)
    const text = e.text.trim()
    if (!['composer', 'bridge'].includes(e.origin.kind) || text.startsWith('/') || [...text.replace(/\s/g, '')].length < 8) return next(e)
    if (!routerScript) {
      $.ui.status('AI判別: 判定スクリプト未設定')
      return next(e)
    }
    if (privateWords.some(word => text.toLowerCase().includes(word))) {
      $.ui.status('AI判別: 外部送信しない内容のためスキップ')
      return next(e)
    }

    const fail = (reason: string) => {
      if (current === sequence) $.ui.status(`AI判別: 失敗（${reason}）`)
    }
    const classify = async () => {
      const cwd = await $.session.cwd()
      const stat = await $.fs.stat(cwd, { resolve: true })
      if (current !== sequence) return
      if (!stat.realPath) { fail('cwd_unresolved'); return }
      const path = normalize(stat.realPath)
      if (privateFolders.some(root => path === root || path.startsWith(`${root}/`))) {
        $.ui.status('AI判別: 外部送信しない内容のためスキップ')
        return
      }
      const result = await $.process.run([pythonPath, routerScript, '--backend', options.backend === 'decisions' ? 'decisions' : 'jev'], {
        stdin: e.text, timeoutMs: 12000,
      })
      if (current !== sequence) return
      if (result.exitCode !== 0) { fail(`exit_${result.exitCode}`); return }
      let data
      try { data = JSON.parse(result.stdout.trim()) } catch { fail('invalid_json'); return }
      if (!data || data.ok !== true) {
        // Never display arbitrary exception messages, stdout or stderr.
        const reason = typeof data?.reason === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(data.reason) ? data.reason : 'invalid_result'
        fail(reason)
        return
      }
      if (!Array.isArray(data.top) || !data.top[0] || typeof data.label !== 'string' || typeof data.entry !== 'string') {
        fail('invalid_result'); return
      }
      const first = data.top[0]
      let message = `→ ${data.label}${percent(first.p)}｜${data.entry}`
      const second = data.top[1]
      if (second && probability(second.p) && typeof second.id === 'string') message += `（次点 ${second.id.charAt(0).toUpperCase() + second.id.slice(1)}${percent(second.p)}）`
      $.ui.toast(message)
      $.ui.status(message)
    }
    void classify().catch(() => fail('process_error'))
    return next(e)
  }).catch(($, e, next) => next(e))
}
