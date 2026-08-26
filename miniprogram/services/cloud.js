// services/cloud.js — callFunction 封装 + 统一错误处理
// 所有客户端动作统一走这里,便于加埋点、错误归一。

const { cloudEnvId } = require('../config.js')

let initialized = false
function ensureInit() {
  if (initialized) return
  wx.cloud.init({ env: cloudEnvId, traceUser: true })
  initialized = true
}

function call(name, data = {}) {
  ensureInit()
  return wx.cloud
    .callFunction({ name, data })
    .then((res) => {
      const r = res.result
      if (r && r.ok === false) {
        const err = new Error(r.error || 'cloud function failed')
        err.code = r.code
        throw err
      }
      return r
    })
}

module.exports = {
  call
}
