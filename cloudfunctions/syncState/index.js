// syncState 云函数(P7 重连,§8)
// 重连拉全量:返回 rooms 全文档 + 本人当前手的 hands 私有文档。
// 兼职心跳:每次调用把本人 players 元素的 connected=true / lastSeen=now 用点路径
// 原位刷新(不整组覆盖、不动 version),其他人 watch 推送即能看到在线状态。
// 客户端在 watch onError 或断线恢复后调用;房间页另设定时器周期调用维持心跳。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const ROOMS = db.collection('rooms')
const HANDS = db.collection('hands')

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { ok: false, code: 'NO_AUTH', error: '无 openid' }
  try {
    return await sync(event, openid)
  } catch (e) {
    console.error('syncState failed', event && event.roomId, e)
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      error: '服务器异常,请重试(' + ((e && e.message) || String(e)) + ')'
    }
  }
}

async function sync(event, openid) {
  const roomId = (event && event.roomId) || ''
  if (!roomId) return { ok: false, code: 'NO_ROOM', error: '缺少 roomId' }

  const found = await ROOMS.doc(roomId).get().catch(() => null)
  if (!found || !found.data) return { ok: false, code: 'NOT_FOUND', error: '房间不存在' }
  const room = found.data

  const idx = (room.players || []).findIndex((p) => p.openid === openid)
  if (idx < 0 && room.status !== 'closed') {
    return { ok: false, code: 'NOT_IN_ROOM', error: '你不在此房间' }
  }

  // 心跳:原位刷新本人 connected/lastSeen(cloud 函数端写库对 watch 的推送不可靠,
  // 但不影响读侧取到最新值;失败可容忍)
  if (idx >= 0) {
    const patch = {}
    patch['players.' + idx + '.connected'] = true
    patch['players.' + idx + '.lastSeen'] = Date.now()
    await ROOMS.doc(roomId).update({ data: patch }).catch(() => {})
  }

  // 本人当前手底牌(管理员 SDK 读,绕过安全规则;跨手残留由 startHand 清理)
  let myHand = null
  if (idx >= 0 && room.handNo) {
    const h = await HANDS.where({ roomId, ownerOpenid: openid, handNo: room.handNo })
      .limit(1)
      .get()
      .catch(() => ({ data: [] }))
    if (h.data.length) myHand = { handNo: h.data[0].handNo, holeCards: h.data[0].holeCards || [] }
  }

  return { ok: true, room, myHand }
}
