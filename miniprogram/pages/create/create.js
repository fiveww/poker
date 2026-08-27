const app = getApp()
const actions = require('../../services/actions.js')
const history = require('../../services/history.js')

Page({
  data: {
    nick: '',
    sb: '10',
    bb: '20',
    initialChips: '1000',
    loanEnabled: false,
    loanAmount: '',
    loanCap: '',
    loanMult: '1.5',
    submitting: false
  },

  onLoad() {
    this.setData({ nick: app.loadNick() })
  },

  onInput(e) {
    const { field } = e.currentTarget.dataset
    const patch = {}
    patch[field] = e.detail.value
    this.setData(patch)
  },

  toggleLoan(e) {
    this.setData({ loanEnabled: e.detail.value })
  },

  async onSubmit() {
    if (this.data.submitting) return
    const { nick, sb, bb, initialChips, loanEnabled, loanAmount, loanCap, loanMult } = this.data

    const cfg = {
      sb: parseInt(sb, 10),
      bb: parseInt(bb, 10),
      initialChips: parseInt(initialChips, 10),
      gameType: 'nlhe'
    }
    if (!Number.isFinite(cfg.sb) || cfg.sb <= 0) return wx.showToast({ title: '小盲须为正整数', icon: 'none' })
    if (!Number.isFinite(cfg.bb) || cfg.bb <= 0) return wx.showToast({ title: '大盲须为正整数', icon: 'none' })
    if (cfg.bb < cfg.sb) return wx.showToast({ title: '大盲不能小于小盲', icon: 'none' })
    if (!Number.isFinite(cfg.initialChips) || cfg.initialChips <= 0) return wx.showToast({ title: '初始筹码须为正整数', icon: 'none' })

    if (loanEnabled) {
      cfg.loan = {
        enabled: true,
        amount: parseInt(loanAmount, 10),
        cap: loanCap === '' ? 0 : parseInt(loanCap, 10),
        repayMultiplier: parseFloat(loanMult)
      }
      if (!Number.isFinite(cfg.loan.amount) || cfg.loan.amount <= 0) {
        return wx.showToast({ title: '开启借款须填正整数借款额', icon: 'none' })
      }
      if (!(cfg.loan.repayMultiplier > 0)) {
        return wx.showToast({ title: '还款倍率须 > 0', icon: 'none' })
      }
    } else {
      cfg.loan = { enabled: false }
    }

    app.setNick(nick)
    this.setData({ submitting: true })
    wx.showLoading({ title: '创建中…', mask: true })
    try {
      const res = await actions.createRoom(cfg, nick)
      history.add(res.roomId, res.roomCode) // 记入本地历史,供首页「历史对局」快速回房
      wx.hideLoading()
      wx.redirectTo({ url: '/pages/room/room?roomId=' + res.roomId + '&roomCode=' + res.roomCode })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: e.message || '创建失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
