// pages/replay — 牌局回看(P9,§8「牌局回看」)
// 数据源:handHistory 集合(安全规则允许房间成员读)。两个页签:
//   最近:按 ts desc 取最近 historyLimit(默认 10)条;
//   收藏:favorite==true 的记录。
// 条目可展开为重放视图:按动作流水逐条推进,公共牌随街(flop 3/turn 4/river 5)
// 渐进亮出,末步摊牌显示赢家与已公开底牌;支持自动播放/步进。
const actions = require('../../services/actions.js')
const { collections } = require('../../config.js')

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function formatTime(ts) {
  const d = new Date(ts)
  return (
    pad(d.getFullYear() % 100) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  )
}

Page({
  data: {
    roomId: '',
    tab: 'recent', // recent | fav
    items: [],
    loading: true,
    limits: { historyLimit: 10, favoriteLimit: 10 }, // 渲染用(数据层另存 this._limits)
    finalLines: [],
    // —— 重放播放态(expandedId 对应条目的当前步)——
    expandedId: '',
    curStep: 0,
    stepCount: 0,
    viewCommSlots: ['', '', '', '', ''],
    curText: '',
    autoPlay: false
  },

  onLoad(query) {
    this.setData({ roomId: (query && query.roomId) || '' })
    this._docs = {} // _id → 原始文档(展开时构建重放步骤用)
    this._steps = [] // 展开条目的步骤数组
    this._limits = { historyLimit: 10, favoriteLimit: 10 }
    this._loadedOnce = true
    this.loadRoomConfig()
    this.loadList()
  },

  onUnload() {
    this.stopAuto()
  },

  loadRoomConfig() {
    wx.cloud
      .database()
      .collection(collections.rooms)
      .doc(this.data.roomId)
      .get()
      .then((res) => {
        const cfg = (res.data && res.data.config) || {}
        if (cfg.historyLimit > 0) this._limits.historyLimit = cfg.historyLimit
        if (cfg.favoriteLimit > 0) this._limits.favoriteLimit = cfg.favoriteLimit
        this.setData({ limits: { ...this._limits } })
      })
      .catch(() => {})
  },

  onShow() {
    // 从牌局返回时可能有新手结束,刷新一次
    if (this._loadedOnce) this.loadList()
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.tab) return
    this.collapse()
    this.setData({ tab })
    this.loadList()
  },

  async loadList() {
    const db = wx.cloud.database()
    const where =
      this.data.tab === 'fav'
        ? { roomId: this.data.roomId, favorite: true }
        : { roomId: this.data.roomId }
    this.setData({ loading: true })
    try {
      const res = await db
        .collection(collections.handHistory)
        .where(where)
        .orderBy('ts', 'desc')
        .limit(this.data.tab === 'fav' ? this._limits.favoriteLimit : this._limits.historyLimit)
        .get()
      this._docs = {}
      const items = res.data.map((d) => {
        this._docs[d._id] = d
        const potTotal = (d.winners || []).reduce((s, w) => s + (w.potShare || 0), 0)
        return {
          id: d._id,
          handNo: d.handNo,
          isFinal: !!d.isFinal,
          timeText: formatTime(d.ts),
          potTotal,
          title: d.isFinal ? '终局 · 整局清算' : '第 ' + d.handNo + ' 手',
          winnersText: (d.winners || [])
            .map((w) => w.nick + (w.hand ? '(' + w.hand + ')' : '') + ' +' + w.potShare)
            .join('、'),
          favorite: !!d.favorite,
          expanded: false
        }
      })
      this.setData({ items, loading: false })
    } catch (e) {
      console.error('load handHistory failed', e)
      this.setData({ loading: false })
      wx.showToast({ title: e.message || '读取失败', icon: 'none' })
    }
  },

  collapse() {
    this.stopAuto()
    const id = this.data.expandedId
    if (!id) return
    this._steps = []
    this.patchItem(id, { expanded: false })
    this.setData({ expandedId: '', curStep: 0, stepCount: 0, curText: '', autoPlay: false })
  },

  patchItem(id, patch) {
    const idx = (this.data.items || []).findIndex((it) => it.id === id)
    if (idx < 0) return
    const data = {}
    Object.keys(patch).forEach((k) => {
      data['items[' + idx + '].' + k] = patch[k]
    })
    this.setData(data)
  },

  buildSteps(doc) {
    const steps = []
    steps.push({ text: '发底牌 · 盲注入池(preflop)', comm: 0 })
    ;(doc.actions || []).forEach((a) => {
      let comm
      if (/进入 flop/.test(a.text || '')) comm = 3
      else if (/进入 turn/.test(a.text || '')) comm = 4
      else if (/进入 river/.test(a.text || '')) comm = 5
      else comm = null
      const last = steps[steps.length - 1]
      // 同一文本的街切换合并到前一步显示(进度仍逐步走)
      if (comm !== null && last && last.comm === comm) {
        last.text = a.text
        last.isStreet = true
      } else {
        steps.push({
          text: a.text,
          comm: comm !== null ? comm : (last ? last.comm : 0),
          isStreet: comm !== null
        })
      }
    })
    if (!doc.isFinal) {
      steps.push({ text: '摊牌 · 开奖', comm: 5, isStreet: true, isEnd: true })
    }
    return steps
  },

  onToggle(e) {
    const { id } = e.currentTarget.dataset
    const doc = this._docs[id]
    if (!doc) return

    if (this.data.expandedId === id) {
      this.collapse()
      return
    }
    const prevId = this.data.expandedId
    this.collapse()

    this._steps = doc.isFinal ? [] : this.buildSteps(doc)
    this.patchItem(id, { expanded: true })
    const count = this._steps.length
    // 终局快照 → 直接列出每人最终余额(强制还款后,可为负)
    let finalLines = []
    if (doc.isFinal) {
      finalLines = (doc.players || [])
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((p) => {
          let line = (p.nick || '玩家') + ':最终 ' + p.finalChips
          if (p.finalChips < 0) line += '(净欠 ' + -p.finalChips + ')'
          return line
        })
    }
    this.setData({
      expandedId: id,
      curStep: doc.isFinal ? -1 : Math.max(0, count - 1),
      stepCount: count,
      autoPlay: false,
      finalLines
    })
    this.renderStep()
    void prevId
  },

  renderStep() {
    const doc = this._docs[this.data.expandedId]
    if (!doc || doc.isFinal) {
      this.setData({ viewCommSlots: ['', '', '', '', ''], curText: '' })
      return
    }
    const i = Math.min(Math.max(this.data.curStep, 0), this._steps.length - 1)
    const st = this._steps[i] || { text: '', comm: 0 }
    const shown = (doc.communityCards || []).slice(0, st.comm)
    const slots = [0, 1, 2, 3, 4].map((n) => shown[n] || '')
    this.setData({
      curStep: i,
      curText: st.text,
      viewCommSlots: slots
    })
  },

  onPrev() {
    this.stopAuto()
    if (this.data.curStep > 0) {
      this.setData({ curStep: this.data.curStep - 1 })
      this.renderStep()
    }
  },
  onNext() {
    this.stopAuto()
    if (this.data.curStep < this._steps.length - 1) {
      this.setData({ curStep: this.data.curStep + 1 })
      this.renderStep()
    }
  },
  startAuto() {
    if (!this._steps.length) return
    this.stopAuto()
    // 默认停在末步(摊牌结果),自动播放则从发底牌从头走
    this.setData({ autoPlay: true, curStep: 0 })
    this.renderStep()
    const tick = () => {
      if (this.data.curStep >= this._steps.length - 1) {
        this.stopAuto()
        return
      }
      this.setData({ curStep: this.data.curStep + 1 })
      this.renderStep()
      this._autoTimer = setTimeout(tick, 900)
    }
    this._autoTimer = setTimeout(tick, 400)
  },
  stopAuto() {
    if (this._autoTimer) {
      clearTimeout(this._autoTimer)
      this._autoTimer = null
    }
    if (this.data.autoPlay) this.setData({ autoPlay: false })
  },
  onAutoToggle() {
    if (this.data.autoPlay) this.stopAuto()
    else this.startAuto()
  },

  // 收藏 / 取消(P9:超上限自动挤掉最早一条,由云端处理)
  async onFav(e) {
    const { id } = e.currentTarget.dataset
    const item = (this.data.items || []).find((it) => it.id === id)
    if (!item) return
    const next = !item.favorite
    try {
      await actions.favoriteHand(this.data.roomId, id, next)
      this.patchItem(id, { favorite: next })
      if (this.data.tab === 'fav' && !next) this.loadList()
    } catch (err) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' })
    }
  },

  goBack() {
    wx.navigateBack()
  }
})
