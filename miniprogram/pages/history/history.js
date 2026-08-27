// pages/history — 历史对局:本机记录的曾加入房间,点击一键重新加入(技术方案 §4.5)
const actions = require('../../services/actions.js')
const history = require('../../services/history.js')

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function formatTime(ts) {
  const d = new Date(ts)
  return (
    pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  )
}

Page({
  data: {
    items: []
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    const items = history.list().map((it) => ({
      ...it,
      timeText: formatTime(it.ts)
    }))
    this.setData({ items })
  },

  // 点击条目:直接凭房间号重新加入
  async onTapRoom(e) {
    const { id, code } = e.currentTarget.dataset
    try {
      const res = await actions.joinRoom(code, getApp().globalData.nick || '')
      history.add(res.roomId, code) // 置顶并刷新
      wx.redirectTo({ url: '/pages/room/room?roomId=' + res.roomId + '&roomCode=' + code })
    } catch (err) {
      if (err.code === 'NOT_FOUND' || err.code === 'CLOSED') {
        // 房间已不存在/已关闭 → 从历史移除该条
        history.remove(id)
        wx.showToast({ title: '房间已关闭,已从历史移除', icon: 'none' })
        this.refresh()
      } else {
        wx.showToast({ title: err.message || '加入失败', icon: 'none' })
      }
    }
  },

  // 长按删除单条
  onLongPress(e) {
    const { id } = e.currentTarget.dataset
    wx.showModal({
      title: '删除这条记录?',
      confirmText: '删除',
      success: (r) => {
        if (!r.confirm) return
        history.remove(id)
        this.refresh()
      }
    })
  },

  onClearAll() {
    wx.showModal({
      title: '清空全部历史?',
      confirmText: '清空',
      success: (r) => {
        if (!r.confirm) return
        wx.setStorageSync('poker_room_history', [])
        this.refresh()
      }
    })
  }
})
