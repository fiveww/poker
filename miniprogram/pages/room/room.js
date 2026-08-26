const app = getApp()
const actions = require('../../services/actions.js')
const { cloudEnvId, collections } = require('../../config.js')

// 牌局进行中的状态集合(区别于 waiting 大厅 / closed 结束)
const PLAYING_STATES = ['preflop', 'flop', 'turn', 'river', 'showdown']

Page({
  data: {
    roomId: '',
    room: null,
    openid: '',
    isHost: false,
    watcherReady: false,
    // —— P2 牌桌视图 ——
    playing: false, // 是否处于一手牌中
    myHoleCards: [], // 本人底牌 ['As','Kd'],空数组 = 未发到/未拉取
    opponents: [], // 其他玩家展示列表
    communitySlots: ['', '', '', '', ''] // 公共牌 5 格('' = 空位)
  },

  onLoad(query) {
    const roomId = (query && query.roomId) || ''
    this.setData({
      roomId,
      openid: app.globalData.openid || ''
    })
    if (!roomId) {
      wx.showToast({ title: '缺少房间', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 800)
      return
    }
    this._handNoFetched = null // 已拉取底牌的手号,防重复拉
    this.openWatcher()
  },

  onUnload() {
    this.closeWatcher()
    this.closeHandsWatcher()
  },

  onShareAppMessage() {
    const room = this.data.room
    const code = (room && room.roomCode) || ''
    return {
      title: '朋友局德扑 · 房间号 ' + code,
      path: '/pages/index/index?roomCode=' + code
    }
  },

  openWatcher() {
    const db = wx.cloud.database()
    this.watcher = db
      .collection(collections.rooms)
      .doc(this.data.roomId)
      .watch({
        onChange: (snapshot) => {
          if (snapshot.docs && snapshot.docs.length) {
            this.applyRoom(snapshot.docs[snapshot.docs.length - 1])
          }
        },
        onError: (err) => {
          console.error('watch rooms error', err)
        }
      })
  },

  closeWatcher() {
    if (this.watcher) {
      this.watcher.close && this.watcher.close()
      this.watcher = null
    }
  },

  // 本人 hands 文档的 watch(P2):正常情况实时收到底牌;
  // 云函数管理员写库推送不可靠时由 fetchMyHand 轮询兜底。
  openHandsWatcher() {
    if (this.handsWatcher || !app.globalData.openid) return
    const db = wx.cloud.database()
    this.handsWatcher = db
      .collection(collections.hands)
      .where({ roomId: this.data.roomId, ownerOpenid: app.globalData.openid })
      .watch({
        onChange: (snapshot) => {
          const docs = snapshot.docs || []
          if (docs.length) this.applyMyHand(docs[docs.length - 1])
        },
        onError: (err) => console.error('watch hands error', err)
      })
  },

  closeHandsWatcher() {
    if (this.handsWatcher) {
      this.handsWatcher.close && this.handsWatcher.close()
      this.handsWatcher = null
    }
  },

  applyMyHand(doc) {
    if (!doc || doc.handNo !== this._handNoFetched) return // 只认当前手
    this.setData({ myHoleCards: doc.holeCards || [] })
  },

  // 主动拉取本人当前手底牌(watch 推送缺失时的兜底,§14.1)
  async fetchMyHand(handNo) {
    try {
      const res = await wx.cloud
        .database()
        .collection(collections.hands)
        .where({ roomId: this.data.roomId, ownerOpenid: app.globalData.openid, handNo })
        .limit(1)
        .get()
      if (res.data && res.data.length && res.data[0].handNo === handNo) {
        this._handNoFetched = handNo
        this.setData({ myHoleCards: res.data[0].holeCards || [] })
        this.openHandsWatcher()
      }
    } catch (e) {
      console.error('fetchMyHand error', e)
    }
  },

  // 统一入口:内容无变化则跳过渲染
  applyRoom(room) {
    const sig = JSON.stringify([
      room.players,
      room.hostOpenid,
      room.status,
      room.handNo,
      room.communityCards,
      room.pot,
      room.dealerSeat,
      room.turnSeat
    ])
    if (sig === this._lastSig) return
    this._lastSig = sig
    const openid = app.globalData.openid
    const playing = PLAYING_STATES.indexOf(room.status) !== -1

    // 手号变化 → 清空旧底牌并重新拉取
    if (this._lastHandNo !== undefined && this._lastHandNo !== room.handNo) {
      this.setData({ myHoleCards: [] })
      this._handNoFetched = null
      this.closeHandsWatcher()
    }
    this._lastHandNo = room.handNo

    // 预计算展示字段(WXML 不能调 page 方法)
    const STATUS_LABELS = {
      dealing: '发牌中',
      preflop: '翻牌前',
      flop: '翻牌圈',
      turn: '转牌圈',
      river: '河牌圈',
      showdown: '摊牌'
    }
    const players = (room.players || []).map((p) => ({
      ...p,
      name: p.nick || '玩家' + ((p.seat !== undefined ? p.seat : 0) + 1),
      isDealer: p.seat === room.dealerSeat,
      isTurn: p.seat === room.turnSeat,
      isMe: p.openid === openid
    }))
    const opponents = players.filter((p) => !p.isMe)
    const myPlayer = players.find((p) => p.isMe)

    const community = room.communityCards || []
    const communitySlots = [0, 1, 2, 3, 4].map((i) => community[i] || '')

    this.setData({
      room,
      openid,
      isHost: room.hostOpenid === openid,
      watcherReady: true,
      playing,
      opponents,
      myPlayer,
      nickname: (myPlayer && myPlayer.name) || '',
      statusLabel: STATUS_LABELS[room.status] || '',
      communitySlots
    })

    // 进入一手牌 → 拉自己的底牌;回到 waiting(手结束)→ 清空
    if (playing && this._handNoFetched !== room.handNo) {
      this.fetchMyHand(room.handNo)
    }
  },

  onCopyCode() {
    if (!this.data.room) return
    wx.setClipboardData({ data: this.data.room.roomCode })
  },

  onBack() {
    this.closeWatcher()
    this.closeHandsWatcher()
    wx.redirectTo({ url: '/pages/index/index' })
  },

  async onLeave() {
    const res = await wx.showModal({ title: '离开房间?', content: '离开后可凭房间号再次加入', confirmText: '离开' })
    if (!res.confirm) return
    try {
      await actions.leaveRoom(this.data.roomId)
      this.onBack()
    } catch (e) {
      wx.showToast({ title: e.message || '离开失败', icon: 'none' })
    }
  },

  onKick(e) {
    const { openid: target } = e.currentTarget.dataset
    wx.showModal({
      title: '移出该玩家?',
      confirmText: '移出',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await actions.leaveRoom(this.data.roomId, target)
        } catch (e) {
          wx.showToast({ title: e.message || '操作失败', icon: 'none' })
        }
      }
    })
  },

  // 房主开一手(P2):调 startHand,结果经 rooms watch 广播回来
  async onStart() {
    if (this._starting) return
    this._starting = true
    try {
      await actions.startHand(this.data.roomId)
    } catch (e) {
      wx.showToast({ title: e.message || '发牌失败', icon: 'none' })
    } finally {
      this._starting = false
    }
  }
})
