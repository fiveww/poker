// revealCards 云函数(主动亮本人底牌,§6.5 新规则:统一只在结算后展示)
// 为避免影响牌局进行中的信息(且防绕过 UI 直接读库偷看),手中途的秀牌请求
// 只写进本人私有的 hands 文档(showAfterSettle 标记,安全规则下仅本人可读),
// 由 action 结算时统一并入 revealedHands / lastResult 面板 / handHistory。
// 结算后(waiting)的补亮(muck 赢家晒牌等)则立即追加到上一手结果面板。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const ROOMS = db.collection('rooms')
const HANDS = db.collection('hands')

const BETTING_STATES = ['preflop', 'flop', 'turn', 'river', 'dealing']

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { ok: false, code: 'NO_AUTH', error: '无 openid' }
  try {
    return await reveal(event, openid)
  } catch (e) {
    console.error('revealCards failed', event && event.roomId, e)
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      error: '服务器异常,请重试(' + ((e && e.message) || String(e)) + ')'
    }
  }
}

async function reveal(event, openid) {
  const roomId = (event && event.roomId) || ''
  if (!roomId) return { ok: false, code: 'NO_ROOM', error: '缺少 roomId' }

  const found = await ROOMS.doc(roomId).get().catch(() => null)
  if (!found || !found.data) return { ok: false, code: 'NOT_FOUND', error: '房间不存在' }
  const room = found.data
  if (room.status === 'closed') return { ok: false, code: 'CLOSED', error: '房间已结束' }

  const me = (room.players || []).find((p) => p.openid === openid)
  if (!me) return { ok: false, code: 'NOT_IN_ROOM', error: '你不在此房间' }

  const handActive = BETTING_STATES.indexOf(room.status) !== -1

  // 当前手必须还有本人的底牌记录(startHand 清旧手,跨手不可回溯)
  const h = await HANDS.where({ roomId, ownerOpenid: openid, handNo: room.handNo })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }))
  if (!h.data.length) {
    return { ok: false, code: 'NO_CARDS', error: '当前手没有你的底牌(跨手不可回溯亮牌)' }
  }

  if (handActive) {
    // —— 牌局进行中:仅私有标记,结算后才对外展示 ——
    if (h.data[0].showAfterSettle) return { ok: true, deferred: true }
    await HANDS.doc(h.data[0]._id).update({ data: { showAfterSettle: true } })
    const now = Date.now()
    await ROOMS.doc(roomId)
      .update({
        data: {
          log: (room.log || []).slice(-50).concat([
            {
              ts: now,
              openid,
              type: 'reveal',
              text: (me.nick || '玩家') + ' 选择在本手结束后亮牌'
            }
          ])
        }
      })
      .catch(() => {}) // 日志失败不影响标记
    return { ok: true, deferred: true }
  }

  // —— 结算后(waiting):直接追加进公开 revealedHands,并补进上局结果面板 ——
  if ((room.revealedHands || []).some((r) => r.openid === openid)) {
    return { ok: true, already: true } // 幂等:已亮过
  }

  const data = {
    revealedHands: _.push([
      {
        openid,
        nick: me.nick || '玩家',
        holeCards: h.data[0].holeCards || [],
        handNo: room.handNo,
        hand: ''
      }
    ])
  }

  // 补进 lastResult.reveals,让大厅结果面板立即显示(面板其余字段原样保留)
  const lr = room.lastResult
  if (lr && lr.title) {
    const reveals = (lr.reveals || []).slice()
    reveals.push({
      openid,
      nick: me.nick || '玩家',
      holeCards: h.data[0].holeCards || [],
      hand: ''
    })
    data.lastResult = _.set(
      Object.assign({}, lr, { reveals, ts: lr.ts || Date.now() })
    )
  }

  const now = Date.now()
  data.log = (room.log || []).slice(-50).concat([
    { ts: now, openid, type: 'reveal', text: (me.nick || '玩家') + ' 亮出了底牌' }
  ])

  await ROOMS.doc(roomId).update({ data })
  return { ok: true }
}
