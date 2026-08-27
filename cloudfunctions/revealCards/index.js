// revealCards 云函数(主动亮本人底牌,§6.5)
// 适用场景(用户定版):①弃牌获胜的赢家想晒牌(muck 后可随时开);
// ②已弃牌者诈唬秀牌;③摊牌未赢者补亮。多人摊牌的必亮部分由 action 结算时自动写入。
// 校验:调用者在座且当前手(hands)仍有其底牌记录(startHand 清旧手防跨手残留)。
// 写入 rooms.revealedHands 公开数组(_.push 原位追加,不动 version 以免干扰下注 CAS)。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const ROOMS = db.collection('rooms')
const HANDS = db.collection('hands')

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

  if ((room.revealedHands || []).some((r) => r.openid === openid)) {
    return { ok: true, already: true } // 幂等:已亮过
  }

  // 当前手必须还有本人的底牌记录(手结束后、下一手开始前这段时间内有效)
  const h = await HANDS.where({ roomId, ownerOpenid: openid, handNo: room.handNo })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }))
  if (!h.data.length) {
    return { ok: false, code: 'NO_CARDS', error: '当前手没有你的底牌(跨手不可回溯亮牌)' }
  }

  const now = Date.now()
  await ROOMS.doc(roomId).update({
    data: {
      revealedHands: _.push([
        {
          openid,
          nick: me.nick || '玩家',
          holeCards: h.data[0].holeCards || [],
          handNo: room.handNo,
          hand: '' // 主动亮牌不评型;摊牌亮牌由 action 结算写入带牌型文案
        }
      ]),
      log: (room.log || []).slice(-50).concat([
        { ts: now, openid, type: 'reveal', text: (me.nick || '玩家') + ' 亮出了底牌' }
      ])
    }
  })
  return { ok: true }
}
