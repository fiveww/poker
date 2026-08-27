// endGame 云函数(P8:房主直接结束整局并清算,§10.4)
// 与 voteEnd 的通过分支共用同一套清算语义:
//   1. 强制还款:对每个玩家 chips -= debt;debt = 0(余额可为负,照扣);
//   2. 计算各玩家最终余额 = chips;
//   3. 写 isFinal=true 的 handHistory 终局快照(含 loan/debt/finalChips);
//   4. status=closed + lastResult 清算面板。
// 仅房主可调;仅限 waiting 态(手与手之间的公平时点)。进行中请走投票(proposeEnd)。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const ROOMS = db.collection('rooms')
const HANDHISTORY = db.collection('handHistory')

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { ok: false, code: 'NO_AUTH', error: '无 openid' }
  try {
    return await endGame(event, openid)
  } catch (e) {
    console.error('endGame failed', event && event.roomId, e)
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      error: '服务器异常,请重试(' + ((e && e.message) || String(e)) + ')'
    }
  }
}

async function endGame(event, openid) {
  const roomId = (event && event.roomId) || ''
  if (!roomId) return { ok: false, code: 'NO_ROOM', error: '缺少 roomId' }

  const found = await ROOMS.doc(roomId).get().catch(() => null)
  if (!found || !found.data) return { ok: false, code: 'NOT_FOUND', error: '房间不存在' }
  const room = found.data

  if (room.hostOpenid !== openid) {
    return { ok: false, code: 'NOT_HOST', error: '仅房主可结束整局' }
  }
  if (room.status !== 'waiting') {
    return { ok: false, code: 'IN_PROGRESS', error: '当前手未结束;想立即结束请在牌桌里发起结束投票' }
  }

  const now = Date.now()
  const players = (room.players || []).map((p) => ({ ...p }))

  // 强制还款(§10.3 关键):chips -= debt;debt=0;余额可为负照扣
  players.forEach((p) => {
    const d = p.debt || 0
    if (d > 0) p.chips = (p.chips || 0) - d
    p.debt = 0
    p.folded = false
    p.allIn = false
    p.bet = 0
    p.totalBet = 0
  })

  const lines = players
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((p) => {
      let line = (p.nick || '玩家') + ':最终 ' + p.chips
      if (p.chips < 0) line += '(净欠 ' + -p.chips + ')'
      else if ((p.loan || 0) > 0) line += '(借 ' + p.loan + ' 已还 ' + (p.repaid || 0) + ')'
      return line
    })

  const historyDoc = {
    roomId,
    handNo: room.handNo,
    ts: now,
    players: players.map((p) => ({
      openid: p.openid,
      nick: p.nick || '',
      seat: p.seat,
      holeCards: [],
      holeRevealed: false,
      finalChips: p.chips,
      delta: 0,
      loan: p.loan || 0,
      debt: 0,
      repaid: p.repaid || 0,
      folded: false
    })),
    communityCards: [],
    winners: [],
    sidePots: [],
    actions: [
      { ts: now, openid, text: '房主结束整局' },
      { ts: now, openid: '', text: '终局强制还款结清欠款(余额可为负)' }
    ],
    favorite: false,
    isFinal: true
  }

  const upd = await ROOMS.where({ _id: roomId, version: room.version }).update({
    data: {
      version: _.inc(1),
      status: 'closed',
      bettingRound: '',
      pot: 0,
      currentBet: 0,
      turnSeat: -1,
      revealedHands: [],
      endVote: _.set({ active: false, initiator: '', yes: [], no: [], threshold: 'all', triggeredHandNo: 0 }),
      players,
      lastResult: _.set({
        handNo: room.handNo,
        title: '整局结束 · 已清算',
        lines: ['房主结束整局'].concat(lines),
        potTotal: 0,
        community: [],
        reveals: [],
        ts: now
      }),
      log: (room.log || []).slice(-50).concat([
        { ts: now, openid, type: 'hand', text: '整局结束 · ' + lines.join(';') }
      ])
    }
  })
  if (!upd.stats || upd.stats.updated === 0) {
    return { ok: false, code: 'CAS_FAIL', error: '状态冲突,请稍候重试' }
  }

  await HANDHISTORY.add({ data: historyDoc }).catch((e) =>
    console.error('final handHistory write failed', e)
  )

  return { ok: true, closed: true }
}
