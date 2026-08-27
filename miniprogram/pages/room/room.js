const app = getApp()
const actions = require('../../services/actions.js')
const { cloudEnvId, collections } = require('../../config.js')

// 牌局进行中的状态集合(区别于 waiting 大厅 / closed 结束)
const PLAYING_STATES = ['dealing', 'preflop', 'flop', 'turn', 'river', 'showdown']

const STATUS_LABELS = {
  dealing: '发牌中',
  preflop: '翻牌前',
  flop: '翻牌圈',
  turn: '转牌圈',
  river: '河牌圈',
  showdown: '摊牌'
}

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
    seated: [], // 全体玩家展示列表(含 name/isMe 等,大厅与牌桌共用)
    opponents: [], // 其他玩家展示列表
    myPlayer: null,
    communitySlots: ['', '', '', '', ''], // 公共牌 5 格('' = 空位)
    // —— P3 行动条视图 ——
    actionBar: null, // null = 非本人行动(myTurn 时含 check/call 额、加注区间等预计算字段)
    raisePanel: false // 加注面板展开态(面板渲染在 myTurn 区块内,轮次变化自动收起)
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
    this._lastHandNoFetched = null
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
  // 云函数管理员写库推送不可靠时由 fetchMyHand 拉取兜底。
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
    if (!doc || doc.handNo !== this._lastHandNoFetched) return // 只认当前手
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
        this._lastHandNoFetched = handNo
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
      room.turnSeat,
      room.currentBet,
      room.version
    ])
    if (sig === this._lastSig) return
    this._lastSig = sig
    const openid = this.data.openid
    const playing = PLAYING_STATES.indexOf(room.status) !== -1

    // 手号变化 → 清空旧底牌并重新拉取
    if (this._seenHandNo !== undefined && this._seenHandNo !== room.handNo) {
      this.setData({ myHoleCards: [] })
      this._lastHandNoFetched = null
      this.closeHandsWatcher()
    }
    this._seenHandNo = room.handNo

    // 盲注位标识(与 startHand 同一套公式):≥3 人 SB=庄家下一位、BB=再下一位;单挑庄家=SB、对家=BB
    const seatList = (room.players || []).map((p) => p.seat).sort((a, b) => a - b)
    const seatN = seatList.length
    const nextOf = (seat, k) => seatList[(seatList.indexOf(seat) + k) % seatN]
    const sbSeat = seatN < 2 ? -1 : seatN === 2 ? room.dealerSeat : nextOf(room.dealerSeat, 1)
    const bbSeat = seatN < 2 ? -1 : seatN === 2 ? nextOf(room.dealerSeat, 1) : nextOf(room.dealerSeat, 2)

    // 预计算展示字段(WXML 不能调 page 方法)
    const players = (room.players || []).map((p) => ({
      ...p,
      name: p.nick || '玩家' + ((p.seat !== undefined ? p.seat : 0) + 1),
      isDealer: p.seat === room.dealerSeat,
      isSB: p.seat === sbSeat,
      isBB: p.seat === bbSeat,
      isTurn: p.seat === room.turnSeat,
      isMe: p.openid === openid
    }))
    const opponents = players.filter((p) => !p.isMe)
    const myPlayer = players.find((p) => p.isMe) || null

    const community = room.communityCards || []
    const communitySlots = [0, 1, 2, 3, 4].map((i) => community[i] || '')

    // —— P4 大厅「上局结果」面板(WXML 不能调方法,在此展开成渲染友好的结构)——
    const lr = room.lastResult
    let lastResultView = null
    if (!playing && lr && lr.handNo) {
      lastResultView = {
        title: lr.title || '第 ' + lr.handNo + ' 手结束',
        lines: lr.lines || [],
        potTotal: lr.potTotal || 0,
        communitySlots: [0, 1, 2, 3, 4].map((i) => (lr.community || [])[i] || ''),
        reveals: (lr.reveals || []).map((r) => ({
          openid: r.openid,
          nick: r.nick || '玩家',
          cards: r.holeCards || [],
          hand: r.hand || ''
        }))
      }
    }

    // —— P3 行动条预计算(WXML 不能调方法,全部在此算好)——
    const BETTING = ['preflop', 'flop', 'turn', 'river']
    let actionBar = null
    if (
      playing &&
      myPlayer &&
      room.turnSeat === myPlayer.seat &&
      !myPlayer.folded &&
      !myPlayer.allIn &&
      BETTING.indexOf(room.status) !== -1
    ) {
      const myBet = myPlayer.bet || 0
      const chips = myPlayer.chips || 0
      const toCall = Math.min(Math.max(0, room.currentBet - myBet), chips)
      const maxTo = myBet + chips
      const minTo = Math.min(maxTo, room.currentBet + room.minRaise)
      const clamp = (v) => Math.max(minTo, Math.min(maxTo, Math.ceil(v / (room.config.sb || 1)) * (room.config.sb || 1)))
      const potTotal = room.pot + Math.max(0, room.currentBet - myBet)
      actionBar = {
        myTurn: true,
        canCheck: toCall === 0,
        callAmt: toCall,
        canRaise: maxTo > room.currentBet,
        minTo,
        maxTo,
        step: room.config.sb || 1,
        raiseTo: minTo,
        presetHalf: clamp(myBet + Math.max(0, room.currentBet - myBet) + potTotal / 2),
        presetPot: clamp(myBet + Math.max(0, room.currentBet - myBet) + potTotal),
        presetAllIn: maxTo
      }
    }
    let turnName = ''
    for (let i = 0; i < players.length; i++) {
      if (players[i].seat === room.turnSeat) turnName = players[i].name
    }

    this.setData({
      room,
      isHost: !!openid && room.hostOpenid === openid,
      watcherReady: true,
      playing,
      seated: players,
      opponents,
      myPlayer,
      statusLabel: STATUS_LABELS[room.status] || '',
      communitySlots,
      lastResultView,
      actionBar,
      turnName
    })

    // 进入一手牌 → 拉自己的底牌;回到 waiting(手结束)→ 清空
    if (playing && this._lastHandNoFetched !== room.handNo && openid) {
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
    const room = this.data.room
    if (!room || (room.players || []).length < 2) {
      wx.showToast({ title: '至少 2 人才能开局', icon: 'none' })
      return
    }
    if (this._starting) return
    this._starting = true
    try {
      await actions.startHand(this.data.roomId)
    } catch (e) {
      wx.showToast({ title: e.message || '发牌失败', icon: 'none' })
    } finally {
      this._starting = false
    }
  },

  // ======== P3 行动 ========

  // 统一发送:CAS 冲突/校验失败都只 toast,新状态由 watch 推回后按钮自动刷新
  async sendAction(action, amount) {
    const room = this.data.room
    if (!room || !this.data.roomId || this._acting) return
    this._acting = true
    try {
      await actions.doAction(this.data.roomId, room.version, action, amount)
    } catch (e) {
      wx.showToast({ title: e.message || '操作失败,请重试', icon: 'none' })
    } finally {
      this._acting = false
    }
  },

  onFold() {
    this.sendAction('fold')
  },
  onCheck() {
    this.sendAction('check')
  },
  onCall() {
    this.sendAction('call')
  },
  onAllIn() {
    this.sendAction('allin')
  },
  onRaisePanelOpen() {
    const bar = this.data.actionBar
    if (!bar) return
    this.setData({ raisePanel: true, 'actionBar.raiseTo': bar.minTo })
  },
  onRaisePanelClose() {
    this.setData({ raisePanel: false })
  },
  onPreset(e) {
    const v = Number(e.currentTarget.dataset.v)
    if (!Number.isFinite(v)) return
    this.setData({ 'actionBar.raiseTo': v })
  },
  onRaiseSlide(e) {
    this.setData({ 'actionBar.raiseTo': Math.round(Number(e.detail.value)) })
  },
  onRaiseConfirm() {
    const to = this.data.actionBar && this.data.actionBar.raiseTo
    if (!Number.isInteger(to)) return
    this.sendAction('raise', to)
    this.setData({ raisePanel: false })
  }
})
