// voteEnd 云函数(P8 结束投票 + 通过后回退清算,§9.2/§9.3)
// 记票:openid 唯一票,重复投返回错误;任一 no 票 → 立即否决并重置投票。
// 通过判定(§13 投票作弊防御):全员同意 = 每个在座玩家要么投了 yes,
// 要么已离线(!connected 或心跳超时)被豁免——离线者不能永久卡死整局。
// 通过后原子完成:
//   1. 当前手作废:回退 players(chips/loan/debt/repaid/folded/allIn/bet)、
//      dealerSeat、communityCards 到 lastHandSnapshot(上一手结算后、按钮移动前);
//   2. 清本房间 hands 私有底牌(当前手已无效);
//   3. 强制还款:chips -= debt;debt = 0(可为负,照扣 §10.3);
//   4. 写 isFinal=true 的 handHistory 终局快照;
//   5. status=closed + lastResult 清算面板。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const ROOMS = db.collection('rooms')
const HANDS = db.collection('hands')
const HANDHISTORY = db.collection('handHistory')

const OFFLINE_MS = 90 * 1000 // 与 action/syncState 的离线阈值一致

function isOffline(p, now) {
  return !p.connected || now - (p.lastSeen || 0) > OFFLINE_MS
}

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { ok: false, code: 'NO_AUTH', error: '无 openid' }
  try {
    return await vote(event, openid)
  } catch (e) {
    console.error('voteEnd failed', event && event.roomId, e)
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      error: '服务器异常,请重试(' + ((e && e.message) || String(e)) + ')'
    }
  }
}

async function vote(event, openid) {
  const roomId = (event && event.roomId) || ''
  const agree = !!(event && event.agree)
  if (!roomId) return { ok: false, code: 'NO_ROOM', error: '缺少 roomId' }

  const found = await ROOMS.doc(roomId).get().catch(() => null)
  if (!found || !found.data) return { ok: false, code: 'NOT_FOUND', error: '房间不存在' }
  const room = found.data

  if (room.status === 'closed') return { ok: false, code: 'CLOSED', error: '房间已结束' }

  const voteState = room.endVote || {}
  if (!voteState.active) return { ok: false, code: 'VOTE_NONE', error: '没有进行中的结束投票' }
  if ((voteState.yes || []).indexOf(openid) !== -1 || (voteState.no || []).indexOf(openid) !== -1) {
    return { ok: false, code: 'ALREADY_VOTED', error: '你已投过票' }
  }

  const me = (room.players || []).find((p) => p.openid === openid)
  if (!me) return { ok: false, code: 'NOT_IN_ROOM', error: '你不在此房间' }

  const now = Date.now()
  const yes = (voteState.yes || []).slice()
  const no = (voteState.no || []).slice()
  ;(agree ? yes : no).push(openid)

  const log0 = (room.log || []).slice(-50)
  const players = room.players || []

  // —— 否决 / 未通过:落票并保持投票开启,等其他人表态 ——
  const passed =
    no.length === 0 &&
    players.every((p) => yes.indexOf(p.openid) !== -1 || isOffline(p, now))

  if (!passed) {
    await ROOMS.doc(roomId).update({
      data: {
        endVote: _.set({ ...voteState, active: no.length === 0, yes, no }),
        log: log0.concat([
          {
            ts: now,
            openid,
            type: 'vote',
            text:
              (me.nick || '玩家') +
              (agree ? ' 同意结束' : ' 反对结束,投票作废')
          }
        ])
      }
    })
    return { ok: true, passed: false, rejected: no.length > 0, yesCount: yes.length, total: players.length }
  }

  // —— 全员同意 → 回退到上一手结算后的快照,再强制清算、关房(§9.3)——
  const snap = room.lastHandSnapshot || null
  let restored
  if (snap && Array.isArray(snap.players)) {
    restored = players.map((p) => {
      const s = snap.players.find((sp) => sp.seat === p.seat)
      // 快照只还原筹码与按钮等公平状态;身份/连接信息保留现值
      return s
        ? {
            ...p,
            chips: s.chips,
            loan: s.loan || 0,
            debt: s.debt || 0,
            repaid: s.repaid || 0,
            folded: false,
            allIn: false,
            bet: 0,
            totalBet: 0,
            acted: false
          }
        : p // 快照之后才入座的人不在其列,P7 后本就不会发生,保底原样保留
    })
  } else {
    // 无快照(理论不发生):至少清掉当前手在桌上的注再清算
    restored = players.map((p) => ({ ...p, folded: false, allIn: false, bet: 0, totalBet: 0, acted: false }))
  }
  const dealerSeat = snap ? snap.dealerSeat : room.dealerSeat

  // 强制还款(§10.3 关键):chips -= debt;debt=0;余额可为负照扣
  restored.forEach((p) => {
    const d = p.debt || 0
    if (d > 0) p.chips = (p.chips || 0) - d
    p.debt = 0
  })

  // 当前手作废,清私有底牌
  await HANDS.where({ roomId }).remove().catch(() => {})

  const lines = restored
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
    handNo: snap ? snap.handNo : room.handNo,
    ts: now,
    players: restored.map((p) => ({
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
      { ts: now, openid, text: '投票通过,整局停在「第 ' + (snap ? snap.handNo : room.handNo) + ' 手前」的公平时点' },
      { ts: now, openid: '', text: '终局强制还款结清欠款(余额可为负)' }
    ],
    favorite: false,
    isFinal: true
  }

  // CAS 落库:一次 update 完成回退 + 强扣 + 关房,防投票与其他动作交错
  const upd = await ROOMS.where({ _id: roomId, version: room.version }).update({
    data: {
      version: _.inc(1),
      status: 'closed',
      bettingRound: '',
      pot: 0,
      currentBet: 0,
      minRaise: room.config.bb,
      turnSeat: -1,
      handNo: snap ? snap.handNo : room.handNo,
      dealerSeat,
      communityCards: snap ? snap.communityCards || [] : [],
      revealedHands: [],
      endVote: _.set({ active: false, initiator: '', yes: [], no: [], threshold: 'all', triggeredHandNo: 0 }),
      players: restored,
      lastResult: _.set({
        handNo: snap ? snap.handNo : room.handNo,
        title: '整局结束 · 已清算',
        lines: ['全员同意结束,当前手作废回退'].concat(lines),
        potTotal: 0,
        community: [],
        reveals: [],
        ts: now
      }),
      log: log0.concat([
        { ts: now, openid, type: 'vote', text: (me.nick || '玩家') + ' 同意结束,投票全票通过' },
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

  return { ok: true, passed: true, closed: true }
}
