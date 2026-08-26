const app = getApp()
const actions = require('../../services/actions.js')

Page({
  data: {
    openid: '',
    ready: false,
    nick: '',
    roomCode: ''
  },

  onLoad(query) {
    // 分享卡片带入的房间号 → 预填
    const code = (query && query.roomCode) || ''
    this.setData({ nick: app.loadNick(), roomCode: code.trim().toUpperCase() })

    if (app.globalData.ready && app.globalData.openid) {
      this.setData({ openid: app.globalData.openid, ready: true })
    } else {
      app.loginReadyCb = (openid) => this.setData({ openid, ready: true })
      app.login()
        .then((openid) => this.setData({ openid, ready: true }))
        .catch(() => wx.showToast({ title: '登录失败,请重试', icon: 'none' }))
    }
  },

  onInputNick(e) {
    this.setData({ nick: e.detail.value })
  },

  onInputRoomCode(e) {
    this.setData({ roomCode: (e.detail.value || '').trim().toUpperCase() })
  },

  onCreateRoom() {
    app.setNick(this.data.nick)
    wx.navigateTo({ url: '/pages/create/create' })
  },

  async onJoinRoom() {
    const code = this.data.roomCode
    if (!code) {
      wx.showToast({ title: '请输入房间号', icon: 'none' })
      return
    }
    app.setNick(this.data.nick)
    wx.showLoading({ title: '加入中…', mask: true })
    try {
      const res = await actions.joinRoom(code, this.data.nick)
      wx.hideLoading()
      wx.redirectTo({ url: '/pages/room/room?roomId=' + res.roomId + '&roomCode=' + code })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: e.message || '加入失败', icon: 'none' })
    }
  }
})
