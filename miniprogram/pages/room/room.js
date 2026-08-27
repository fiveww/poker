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

// 离线判定阈值:与云函数(action 代弃牌 / voteEnd 豁免)保持一致
const OFFLINE_MS = 90 * 1000

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
    raisePanel: false, // 加注面板展开态(面板渲染在 myTurn 区块内,轮次变化自动收起)
    // —— P6 借款视图 ——
    loanEnabled: false,
    canBorrow: false,
    borrowAmount: 0,
    canRepay: false,
    // —— P7 在线状态 ——
    onlineCount: 0,
    // —— P8 投票视图 ——
    endVoteView: null // { initiatorName, yesCount, total, myVoted }
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

  onShow() {
    // P7:回到前台立即拉全量对齐(watch 可能错过期间的推送),并恢复心跳
    if (this.data.roomId && app.globalData.openid) {
      this.syncNow()
    }
    this.startTimers()
  },

  onHide() {
    this.stopTimers()
  },

  onUnload() {
    this.stopTimers()
    this.closeWatcher()
    this.closeHandsWatcher()
  },

  onShareAppMessage() {
    const room = this.data.room
    const code = (room && room.roomCode) || ''
    return {
      title: '德扑 · 房间号 ' + code,
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
          // 推送通道异常 → 拉全量兜底(P7),后续 onShow 心跳持续对齐
          this.syncNow()
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
  // 云函数管理员写库推送不可靠时由 fetchMyHand/syncState 拉取兜底。
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

  // ======== P7 重连与心跳 ========

  startTimers() {
    if (!app.globalData.openid) return
    this.stopTimers()
    // 心跳:周期调 syncState 刷新本人 connected/lastSeen,顺带拉全量兜底
    this._hbTimer = setInterval(() => this.syncNow(), 20 * 1000)
    // 存在感渲染:lastSeen 是本地更新的,watch 推送无关 → 定期重算离线标签
    this._presenceTimer = setInterval(() => this.refreshPresence(), 10 * 1000)
  },

  stopTimers() {
    if (this._hbTimer) {
      clearInterval(this._hbTimer)
      this._hbTimer = null
    }
    if (this._presenceTimer) {
      clearInterval(this._presenceTimer)
      this._presenceTimer = null
    }
  },

  syncNow() {
    const roomId = this.data.roomId
    if (!roomId || this._syncing) return
    this._syncing = true
    actions
      .syncState(roomId)
      .then((res) => {
        if (res.room) this.applyRoom(res.room)
        if (
          res.myHand &&
          this._lastHandNoFetched === res.myHand.handNo &&
          res.myHand.holeCards &&
          res.myHand.holeCards.length
        ) {
          this.setData({ myHoleCards: res.myHand.holeCards })
        }
      })
      .catch((e) => {
        if (e.code === 'NOT_FOUND') this.closeWatcher()
        console.error('syncState error', e)
      })
      .then(() => {
        this._syncing = false
      })
  },

  // 用缓存文档重算离线标签(lastSeen 本地推演,不触发额外请求)
  refreshPresence() {
    const room = this.data.room
    if (!room) return
    this.applyRoom(room, true)
  },

  // 统一入口:内容无变化则跳过渲染(force=true 强制重算在线标签等衍生字段)
  applyRoom(room, force) {
    this._rawRoom = room
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
      room.version,
      room.endVote
    ])
    if (!force && sig === this._lastSig) return
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

    const now = Date.now()

    // 预计算展示字段(WXML 不能调 page 方法)
    const players = (room.players || []).map((p) => ({
      ...p,
      name: p.nick || '玩家' + ((p.seat !== undefined ? p.seat : 0) + 1),
      isDealer: p.seat === room.dealerSeat,
      isSB: p.seat === sbSeat,
      isBB: p.seat === bbSeat,
      isTurn: p.seat === room.turnSeat,
      isMe: p.openid === openid,
      // P7:离线标签(心跳超时或显式断开);房主可点击代为弃牌(仅进行中)
      offline: p.connected === false || now - (p.lastSeen || 0) > OFFLINE_MS
    }))
    const opponents = players.filter((p) => !p.isMe)
    const myPlayer = players.find((p) => p.isMe) || null
    const onlineCount = players.filter((p) => !p.offline).length

    const community = room.communityCards || []
    const communitySlots = [0, 1, 2, 3, 4].map((i) => community[i] || '')

    // —— 大厅结果面板(waiting 展示上一手,closed 展示整局清算,startHand 时清空)——
    const lr = room.lastResult
    let lastResultView = null
    if (lr && lr.handNo && (!playing || room.status === 'closed')) {
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

    // —— P6 借款按钮可见性(waiting 态主用;下注阶段轮到本人时服务端也放行)——
    const loanCfg = (room.config && room.config.loan) || {}
    const loanEnabled = !!loanCfg.enabled
    const canBorrow =
      loanEnabled && !!myPlayer && myPlayer.chips === 0 &&
      !(loanCfg.cap > 0 && (myPlayer.loan || 0) >= loanCfg.cap)
    const canRepay =
      loanEnabled && !!myPlayer && (myPlayer.debt || 0) > 0 && (myPlayer.chips || 0) > 0

    // —— P8 投票条 ——
    const ev = room.endVote || {}
    let endVoteView = null
    if (ev.active) {
      const initiator = players.find((p) => p.openid === ev.initiator)
      endVoteView = {
        active: true,
        initiatorName: (initiator && initiator.name) || '玩家',
        yesCount: (ev.yes || []).length,
        noCount: (ev.no || []).length,
        total: players.length,
        myVoted:
          (ev.yes || []).indexOf(openid) !== -1 || (ev.no || []).indexOf(openid) !== -1,
        rejected: (ev.no || []).length > 0
      }
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
      turnName,
      loanEnabled,
      canBorrow,
      borrowAmount: loanCfg.amount || 0,
      canRepay,
      onlineCount,
      endVoteView
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
    this.stopTimers()
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

  // ======== P7:房主把离线玩家代为弃牌(完整走 action 的 fold 结算路径)========

  onSeatTap(e) {
    const { openid: target, offline, folded, allin } = e.currentTarget.dataset
    const room = this.data.room
    if (!room || !this.data.isHost || !this.data.playing) return
    if (!offline || folded || allin) return
    wx.showModal({
      title: '标记对方弃牌?',
      content: '该玩家当前离线,标记弃牌后牌局继续推进',
      confirmText: '代弃',
      success: async (r) => {
        if (!r.confirm) return
        await this.sendAction('fold', undefined, { forOpenid: target })
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
  async sendAction(action, amount, extra) {
    const room = this.data.room
    if (!room || !this.data.roomId || this._acting) return false
    this._acting = true
    try {
      await actions.doAction(this.data.roomId, room.version, action, amount, extra)
      return true
    } catch (e) {
      wx.showToast({ title: e.message || '操作失败,请重试', icon: 'none' })
      return false
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
  },

  // ======== P6 借款 / 还款 ========

  onBorrow() {
    wx.showModal({
      title: '借款 ' + this.data.borrowAmount + '?',
      content: '按还款倍率计入欠款,游戏结束强制扣除',
      confirmText: '借款',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await actions.borrow(this.data.roomId)
          this.syncNow()
        } catch (e) {
          wx.showToast({ title: e.message || '借款失败', icon: 'none' })
        }
      }
    })
  },

  onRepay() {
    const mp = this.data.myPlayer
    if (!mp) return
    wx.showModal({
      title: '还款',
      content: '当前欠款 ' + mp.debt + ',筹码 ' + mp.chips + '\n输入还款金额(留空 = 全额还清)',
      editable: true,
      placeholderText: String(Math.min(mp.chips, mp.debt)),
      confirmText: '还款',
      success: async (r) => {
        if (!r.confirm) return
        const v = String(r.content || '').trim()
        const amount = v ? parseInt(v, 10) : undefined
        if (v && !Number.isInteger(amount)) {
          wx.showToast({ title: '请输入整数金额', icon: 'none' })
          return
        }
        try {
          await actions.repay(this.data.roomId, amount)
          this.syncNow()
        } catch (e) {
          wx.showToast({ title: e.message || '还款失败', icon: 'none' })
        }
      }
    })
  },

  // ======== P8 投票结束 ========

  onProposeEnd() {
    wx.showModal({
      title: '发起结束本局?',
      content: '全员同意后本手作废、回退上一手结算点并清算关房',
      confirmText: '发起',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await actions.proposeEnd(this.data.roomId)
        } catch (e) {
          wx.showToast({ title: e.message || '发起失败', icon: 'none' })
        }
      }
    })
  },

  onVoteAgree() {
    actions.voteEnd(this.data.roomId, true).catch((e) =>
      wx.showToast({ title: e.message || '投票失败', icon: 'none' })
    )
  },

  onVoteReject() {
    actions.voteEnd(this.data.roomId, false).catch((e) =>
      wx.showToast({ title: e.message || '投票失败', icon: 'none' })
    )
  },

  onEndGame() {
    wx.showModal({
      title: '结束整局并清算?',
      content: '强制结清欠款(余额可为负),写终局记录后关房',
      confirmText: '结束',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await actions.endGame(this.data.roomId)
        } catch (e) {
          wx.showToast({ title: e.message || '操作失败', icon: 'none' })
        }
      }
    })
  },

  // ======== P9 牌局记录入口 ========

  // 主动亮底牌(§6.5 新规则:统一只在结算后展示)
  // 牌局进行中点按 = 登记意愿(私密),手终结算时并入公开结果;
  // 结算后(waiting)点按 = 立即补进上局结果面板
  onReveal() {
    actions.revealCards(this.data.roomId)
      .then((r) => {
        if (r.deferred) wx.showToast({ title: '已登记,本手结束后公开展示', icon: 'none' })
        else if (r.already) wx.showToast({ title: '你已亮过牌', icon: 'none' })
        else wx.showToast({ title: '已亮出,展示在上局结果里', icon: 'none' })
      })
      .catch((e) => wx.showToast({ title: e.message || '亮牌失败', icon: 'none' }))
  },

  onOpenRecords() {
    wx.navigateTo({
      url: '/pages/replay/replay?roomId=' + this.data.roomId + '&closed=' + (this.data.room && this.data.room.status === 'closed' ? 1 : 0)
    })
  },

  onExitClosed() {
    wx.reLaunch({ url: '/pages/index/index' })
  }
})
