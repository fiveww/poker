// repay 云函数(P6 手动还款,§10.3)
// P4 定版修订后欠款的结清途径只剩两条:玩家手动 repay 或游戏结束强制清算(endGame)。
// 用现有 chips 主动还:chips -= amount;debt -= amount;repaid += amount。
// 不限时机(waiting / 下注中均可),amount 默认为全部可还额度 min(chips, debt)。
// 写库同样走点路径 + _.inc,避免整组 players 覆盖。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const ROOMS = db.collection('rooms')

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { ok: false, code: 'NO_AUTH', error: '无 openid' }
  try {
    return await repay(event, openid)
  } catch (e) {
    console.error('repay failed', event && event.roomId, e)
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      error: '服务器异常,请重试(' + ((e && e.message) || String(e)) + ')'
    }
  }
}

async function repay(event, openid) {
  const roomId = (event && event.roomId) || ''
  if (!roomId) return { ok: false, code: 'NO_ROOM', error: '缺少 roomId' }

  const found = await ROOMS.doc(roomId).get().catch(() => null)
  if (!found || !found.data) return { ok: false, code: 'NOT_FOUND', error: '房间不存在' }
  const room = found.data
  if (room.status === 'closed') return { ok: false, code: 'CLOSED', error: '房间已结束' }

  const players = room.players || []
  const idx = players.findIndex((p) => p.openid === openid)
  if (idx < 0) return { ok: false, code: 'NOT_IN_ROOM', error: '你不在此房间' }
  const me = players[idx]

  const debt = me.debt || 0
  if (debt <= 0) return { ok: false, code: 'NO_DEBT', error: '你没有欠款' }
  if ((me.chips || 0) <= 0) return { ok: false, code: 'NO_CHIPS', error: '没有可用于还款的筹码' }

  // 未传 amount → 全额结清(chips 与 debt 取小者)
  let amount = Number.isInteger(Number(event.amount)) ? Number(event.amount) : Math.min(me.chips, debt)
  if (!(amount > 0)) return { ok: false, code: 'BAD_AMOUNT', error: '金额不合法' }
  if (amount > me.chips) return { ok: false, code: 'NO_CHIPS', error: '筹码不足' }
  if (amount > debt) amount = debt

  const data = {}
  data['players.' + idx + '.chips'] = _.inc(-amount)
  data['players.' + idx + '.debt'] = _.inc(-amount)
  data['players.' + idx + '.repaid'] = _.inc(amount)

  const now = Date.now()
  data.log = (room.log || []).slice(-50).concat([
    {
      ts: now,
      openid,
      type: 'repay',
      text: (me.nick || '玩家') + ' 还款 ' + amount
    }
  ])

  await ROOMS.doc(roomId).update({ data })
  return {
    ok: true,
    paid: amount,
    debtLeft: Math.max(0, debt - amount),
    chips: me.chips - amount
  }
}
