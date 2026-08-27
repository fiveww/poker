// leaveRoom 云函数(P1 离座)
// 自离;房主可传 targetOpenid 踢人。房主离开则转让给剩余最低 seat;无人则 status=closed。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const ROOMS = db.collection('rooms')

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return { ok: false, code: 'NO_AUTH', error: '无 openid' }

  const roomId = (event && event.roomId) || ''
  if (!roomId) return { ok: false, code: 'NO_ROOM', error: '缺少 roomId' }

  const target = event.targetOpenid || openid // 房主踢人时可指定;否则为本人

  const found = await ROOMS.doc(roomId).get().catch(() => null)
  if (!found || !found.data) return { ok: false, code: 'NOT_FOUND', error: '房间不存在' }
  const room = found.data

  // 踢人权限:仅房主可踢他人
  if (target !== openid && room.hostOpenid !== openid) {
    return { ok: false, code: 'FORBIDDEN', error: '仅房主可踢人' }
  }
  if (room.status !== 'waiting') {
    return { ok: false, code: 'IN_PROGRESS', error: '牌局进行中不能移出座位;可对离线玩家「代为弃牌」推进牌局' }
  }

  const players = room.players || []
  const remain = players.filter((p) => p.openid !== target)
  if (remain.length === players.length) {
    return { ok: false, code: 'NOT_IN_ROOM', error: '该玩家不在房间' }
  }

  const now = Date.now()
  const log = (room.log || []).concat([
    { ts: now, openid: target, type: 'leave', text: '离开房间' + (target !== openid ? '(被房主移出)' : '') }
  ])

  // 房主离开且有剩余 → 转让给最低 seat
  let patch = { players: remain, log }
  if (target === room.hostOpenid && remain.length > 0) {
    const nextHost = remain.slice().sort((a, b) => a.seat - b.seat)[0]
    patch.hostOpenid = nextHost.openid
    patch.log = log.concat([{ ts: now, openid: nextHost.openid, type: 'host', text: '成为新房主' }])
  }

  if (remain.length === 0) {
    patch.status = 'closed'
  }

  await ROOMS.doc(roomId).update({ data: patch })
  return { ok: true, closed: remain.length === 0 }
}
