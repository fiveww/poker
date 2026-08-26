const { cloudEnvId } = require('./config.js')

const STORAGE_NICK = 'poker_nick'

App({
  globalData: {
    openid: '',
    cloudEnvId,
    ready: false,
    nick: ''
  },

  // 昵称持久化(创建/加入时携带)
  loadNick() {
    if (this.globalData.nick) return this.globalData.nick
    const n = wx.getStorageSync(STORAGE_NICK) || ''
    this.globalData.nick = n
    return n
  },
  setNick(nick) {
    this.globalData.nick = nick || ''
    wx.setStorageSync(STORAGE_NICK, this.globalData.nick)
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
      return
    }
    wx.cloud.init({
      env: cloudEnvId,
      traceUser: true
    })
    this.login()
  },

  // openid 登录:调用 login 云函数获取稳定身份
  login() {
    return wx.cloud
      .callFunction({
        name: 'login',
        data: {}
      })
      .then((res) => {
        const openid = (res.result && res.result.openid) || ''
        this.globalData.openid = openid
        this.globalData.ready = true
        // 通知各页面登录就绪
        if (this.loginReadyCb) this.loginReadyCb(openid)
        return openid
      })
      .catch((err) => {
        console.error('login 云函数调用失败', err)
        this.globalData.ready = false
        throw err
      })
  }
})
