// proposeEnd 云函数(P8 发起结束投票,§9.2)
// 任一玩家发起:endVote.active=true,记录 initiator 与 triggeredHandNo。
// 阈值固定全员同意(threshold=all);票数累计与通过判定在 voteEnd 内完成。
// 新一手开始时 startHand 会重置 endVote。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const ROOMS = db.collection('rooms')

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { ok: false, code: 'NO_AUTH', error: '无 openid' }
  try {
    return await propose(event, openid)
  } catch (e) {
    console.error('proposeEnd failed', event && event.roomId, e)
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      error: '服务器异常,请重试(' + ((e && e.message) || String(e)) + ')'
    }
  }
}

async function propose(event, openid) {
  const roomId = (event && event.roomId) || ''
  if (!roomId) return { ok: false, code: 'NO_ROOM', error: '缺少 roomId' }

  const found = await ROOMS.doc(roomId).get().catch(() => null)
  if (!found || !found.data) return { ok: false, code: 'NOT_FOUND', error: '房间不存在' }
  const room = found.data

  if (room.status === 'closed') return { ok: false, code: 'CLOSED', error: '房间已结束' }

  const players = room.players || []
  const me = players.find((p) => p.openid === openid)
  if (!me) return { ok: false, code: 'NOT_IN_ROOM', error: '你不在此房间' }

  if ((room.endVote || {}).active) {
    return { ok: false, code: 'VOTE_ACTIVE', error: '已有进行中的结束投票' }
  }

  const now = Date.now()
  await ROOMS.doc(roomId).update({
    data: {
      endVote: _.set({
        active: true,
        initiator: openid,
        yes: [openid],
        no: [],
        threshold: 'all',
        triggeredHandNo: room.handNo || 0
      }),
      log: (room.log || []).slice(-50).concat([
        { ts: now, openid, type: 'vote', text: (me.nick || '玩家') + ' 发起「结束本局」投票' }
      ])
    }
  })
  return { ok: true }
}
