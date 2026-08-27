// borrow 云函数(P6 借款,§10.2)
// 前提:config.loan.enabled(默认关)。唯一条件 chipsZero:筹码归零方可借。
// 金额固定为 config.loan.amount;cap>0 时校验累计借入 loan+amount ≤ cap。
// 时机:「借款为非动作动作」——等待阶段(waiting)随时可借,下注阶段仅限轮到自己,
// 不影响下注推进(turnSeat/pot 等一概不动)。
// 执行:chips += amount;loan += amount;debt = round(loan × repayMultiplier)。
// 写库用点路径 + _.inc 定位本人元素,避免整组 players 覆盖与并发动作互踩。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const ROOMS = db.collection('rooms')

const BETTING_STATES = ['preflop', 'flop', 'turn', 'river']

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { ok: false, code: 'NO_AUTH', error: '无 openid' }
  try {
    return await borrow(event, openid)
  } catch (e) {
    console.error('borrow failed', event && event.roomId, e)
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      error: '服务器异常,请重试(' + ((e && e.message) || String(e)) + ')'
    }
  }
}

async function borrow(event, openid) {
  const roomId = (event && event.roomId) || ''
  if (!roomId) return { ok: false, code: 'NO_ROOM', error: '缺少 roomId' }

  const found = await ROOMS.doc(roomId).get().catch(() => null)
  if (!found || !found.data) return { ok: false, code: 'NOT_FOUND', error: '房间不存在' }
  const room = found.data
  if (room.status === 'closed') return { ok: false, code: 'CLOSED', error: '房间已结束' }

  const loanCfg = (room.config && room.config.loan) || {}
  if (!loanCfg.enabled) return { ok: false, code: 'LOAN_DISABLED', error: '本房未开启借款' }

  const players = room.players || []
  const idx = players.findIndex((p) => p.openid === openid)
  if (idx < 0) return { ok: false, code: 'NOT_IN_ROOM', error: '你不在此房间' }
  const me = players[idx]

  // 时机校验:waiting 随时可借;下注阶段须轮到自己且未弃牌(§10.2)
  const inBetting = BETTING_STATES.indexOf(room.status) !== -1
  if (!(room.status === 'waiting' || (inBetting && room.turnSeat === me.seat))) {
    return { ok: false, code: 'BAD_TIMING', error: '请在等待阶段或轮到你时借款' }
  }

  // 条件校验(§10.1):conditions 含 chipsZero → 筹码必须归零
  if ((loanCfg.conditions || []).indexOf('chipsZero') !== -1 && me.chips !== 0) {
    return { ok: false, code: 'CHIPS_NOT_ZERO', error: '筹码归零后才能借款' }
  }

  const amount = Number(loanCfg.amount)
  if (!(amount > 0)) return { ok: false, code: 'BAD_CONFIG', error: '借款配置无效' }

  // 上限:cap=0 不限,否则累计借入不得超 cap
  if (loanCfg.cap > 0 && (me.loan || 0) + amount > loanCfg.cap) {
    return { ok: false, code: 'CAP_REACHED', error: '累计借款已达上限' }
  }

  const mult = Number(loanCfg.repayMultiplier) > 0 ? Number(loanCfg.repayMultiplier) : 1
  const newLoan = (me.loan || 0) + amount
  const newDebt = Math.round(newLoan * mult)

  const data = {}
  data['players.' + idx + '.chips'] = _.inc(amount)
  data['players.' + idx + '.loan'] = _.inc(amount)
  // debt 是推导值(loan×倍率),直接写绝对值即可
  data['players.' + idx + '.debt'] = newDebt

  const now = Date.now()
  data.log = (room.log || []).slice(-50).concat([
    {
      ts: now,
      openid,
      type: 'loan',
      text:
        (me.nick || '玩家') + ' 借款 ' + amount +
        '(累计欠 ' + newDebt + ')'
    }
  ])

  await ROOMS.doc(roomId).update({ data })
  return { ok: true, loan: newLoan, debt: newDebt, chips: me.chips + amount }
}
