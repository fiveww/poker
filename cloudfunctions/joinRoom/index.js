// joinRoom 云函数(P1 入座)
// 按 roomCode 查房,校验状态(status===waiting)、人数<10,
// 分配最小可用 seat,chips=config.initialChips,已加入则幂等返回。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const ROOMS = db.collection('rooms')

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return { ok: false, code: 'NO_AUTH', error: '无 openid' }

  const roomCode = (event && String(event.roomCode || '').trim().toUpperCase()) || ''
  if (!roomCode) return { ok: false, code: 'NO_CODE', error: '请输入房间号' }
  const nick = (event && event.nick) || ''
  const avatar = (event && event.avatar) || ''

  const found = await ROOMS.where({ roomCode }).limit(1).get()
  if (!found.data.length) return { ok: false, code: 'NOT_FOUND', error: '房间号不存在' }
  const room = found.data[0]
  const roomId = room._id

  if (room.status === 'closed') return { ok: false, code: 'CLOSED', error: '房间已关闭' }
  if (room.status !== 'waiting') return { ok: false, code: 'IN_PROGRESS', error: '牌局已开始,无法加入' }

  const players = room.players || []

  // 幂等:已在座则直接返回
  const me = players.find((p) => p.openid === openid)
  if (me) return { ok: true, roomId, seat: me.seat, alreadyIn: true }

  if (players.length >= 10) return { ok: false, code: 'FULL', error: '房间已满(10 人)' }

  // 最小可用 seat
  const used = new Set(players.map((p) => p.seat))
  let seat = 0
  while (used.has(seat)) seat++

  const now = Date.now()
  const newPlayer = {
    openid,
    nick,
    avatar,
    seat,
    chips: room.config.initialChips,
    folded: false,
    allIn: false,
    bet: 0,
    totalBet: 0,
    active: true,
    loan: 0,
    debt: 0,
    repaid: 0,
    connected: true,
    lastSeen: now
  }

  const log = (room.log || []).concat([
    { ts: now, openid, type: 'join', text: '加入座位 ' + seat }
  ])

  await ROOMS.doc(roomId).update({
    data: { players: [...players, newPlayer], log }
  })

  return { ok: true, roomId, seat }
}
