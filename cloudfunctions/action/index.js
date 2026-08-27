// action 云函数(P3 下注)
// 玩家行动:fold/check/call/raise/allIn。CAS 校验 version(§13)→ 校验轮到本人 →
// 动作合法性校验 → 更新 bet/chips/pot/currentBet/minRaise → 推进 turnSeat。
// 本轮结束判定:所有可行动玩家(未 fold 未 allIn)已行动且下注相等 → 发下一街公共牌;
// river 结束 → showdown(P4 才评牌分池);可行动玩家 <2 → 直接发完 5 张进 showdown。
// 只剩 1 人未 fold → 直接获胜(muck,不进 showdown),赢家拿底池,回到 waiting(§6.3.6)。
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const ROOMS = db.collection('rooms')
const HANDS = db.collection('hands')

const SUITS = ['s', 'h', 'd', 'c']
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']

const BETTING_STATES = ['preflop', 'flop', 'turn', 'river']
const NEXT_STREET = { preflop: 'flop', flop: 'turn', turn: 'river' }
const STREET_CARDS = { flop: 3, turn: 1, river: 1 }

// 从「未发出的牌」里随机抽 n 张(CSPRNG):排除所有人底牌(hands 私有文档)+ 已亮公共牌
async function dealCards(roomId, community, n) {
  const used = new Set()
  ;(community || []).forEach((c) => used.add(c))
  const handDocs = await HANDS.where({ roomId }).get().catch(() => ({ data: [] }))
  handDocs.data.forEach((d) => (d.holeCards || []).forEach((c) => used.add(c)))
  const deck = []
  for (const s of SUITS) for (const r of RANKS) if (!used.has(r + s)) deck.push(r + s)
  const out = []
  for (let i = 0; i < n && deck.length; i++) {
    const j = crypto.randomInt(deck.length)
    out.push(deck[j])
    deck.splice(j, 1)
  }
  return out
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return { ok: false, code: 'NO_AUTH', error: '无 openid' }

  const roomId = (event && event.roomId) || ''
  const version = Number(event && event.version)
  const act = (event && event.action) || ''
  if (!roomId || !Number.isInteger(version)) {
    return { ok: false, code: 'BAD_REQ', error: '参数缺失' }
  }
  if (!['fold', 'check', 'call', 'raise', 'allin'].includes(act)) {
    return { ok: false, code: 'BAD_ACTION', error: '未知动作' }
  }

  const found = await ROOMS.doc(roomId).get().catch(() => null)
  if (!found || !found.data) return { ok: false, code: 'NOT_FOUND', error: '房间不存在' }
  const room = found.data

  // —— 状态校验 ——
  if (BETTING_STATES.indexOf(room.status) === -1) {
    return { ok: false, code: 'NOT_BETTING', error: '当前不在下注阶段' }
  }
  const players = (room.players || []).map((p) => ({ ...p }))
  const me = players.find((p) => p.openid === openid)
  if (!me) return { ok: false, code: 'NOT_IN_ROOM', error: '你不在此房间' }
  if (room.turnSeat !== me.seat) return { ok: false, code: 'NOT_YOUR_TURN', error: '还没轮到你' }
  if (me.folded || me.allIn) return { ok: false, code: 'CANNOT_ACT', error: '你本手无需行动' }

  const bb = room.config.bb
  const seats = players.map((p) => p.seat).sort((a, b) => a - b)
  const bySeat = new Map(players.map((p) => [p.seat, p]))
  const n = seats.length
  // 从某座位的下一个座位起,环形找第一个能行动的人;找不到返回 null
  const nextActorFrom = (seat, excludeSelf) => {
    const startIdx = seats.indexOf(seat) + (excludeSelf ? 1 : 0)
    for (let k = 0; k <= n; k++) {
      const p = bySeat.get(seats[(startIdx + k) % n])
      if (p && !p.folded && !p.allIn) return p
    }
    return null
  }

  let delta = 0 // 本次实际投入
  let logText = ''

  // —— 动作处理 ——
  if (act === 'fold') {
    me.folded = true
    logText = (me.nick || '玩家') + ' 弃牌'
  } else if (act === 'check') {
    if (me.bet !== room.currentBet) {
      return { ok: false, code: 'CHECK_ILLEGAL', error: '有人下注,不能过牌' }
    }
    logText = (me.nick || '玩家') + ' 过牌'
  } else if (act === 'call') {
    delta = Math.min(room.currentBet - me.bet, me.chips)
    if (delta <= 0) {
      // 已与当前注相等,fallback 为 check 语义也放行
      logText = (me.nick || '玩家') + ' 过牌'
    } else {
      me.chips -= delta
      me.bet += delta
      me.totalBet = (me.totalBet || 0) + delta
      if (me.chips === 0) me.allIn = true
      logText = (me.nick || '玩家') + (me.allIn ? ' 全下跟注 ' : ' 跟注 ') + delta
    }
  } else {
    // raise / allin:统一按「加注到的总额 raiseTo」处理(allin 忽略 amount,直接全下)
    const raiseTo = act === 'allin' ? me.bet + me.chips : Number(event.amount)
    if (!Number.isInteger(raiseTo) || raiseTo <= 0) {
      return { ok: false, code: 'BAD_AMOUNT', error: '金额不合法' }
    }
    if (raiseTo > me.bet + me.chips) {
      return { ok: false, code: 'NO_CHIPS', error: '筹码不足' }
    }
    const minRaiseTo = room.currentBet + room.minRaise
    const isAllIn = raiseTo === me.bet + me.chips
    if (raiseTo < minRaiseTo && !isAllIn) {
      return { ok: false, code: 'RAISE_TOO_SMALL', error: '加注至少到 ' + minRaiseTo }
    }
    delta = raiseTo - me.bet
    me.chips -= delta
    me.bet = raiseTo
    me.totalBet = (me.totalBet || 0) + delta
    if (me.chips === 0) me.allIn = true
    const prevCurrentBet = room.currentBet
    // 完整加注(min 以上或虽短但是纯 all-in 且超过当前注)才重开行动权、更新 minRaise
    const isAggression = raiseTo > prevCurrentBet
    const fullRaise = isAggression && raiseTo - prevCurrentBet >= room.minRaise
    if (isAggression) {
      room.currentBet = raiseTo
      if (fullRaise) room.minRaise = raiseTo - prevCurrentBet
    }
    // 加注重开行动:其他可行动玩家的 acted 清零
    if (fullRaise) {
      players.forEach((p) => {
        if (p.seat !== me.seat && !p.folded && !p.allIn) p.acted = false
      })
    }
    logText =
      (me.nick || '玩家') +
      (isAggression ? (me.allIn ? ' 全下加注到 ' : ' 加注到 ') + raiseTo : ' 全下跟注 ' + delta)
  }

  if (delta > 0) room.pot += delta
  me.acted = true

  const survivors = players.filter((p) => !p.folded)

  const updateData = {}

  // —— 只剩 1 人未 fold:直接获胜,默认 muck,回 waiting(§6.3.6)——
  if (survivors.length === 1) {
    const winner = survivors[0]
    winner.chips += room.pot
    players.forEach((p) => {
      p.bet = 0
      p.acted = false
    })
    updateData.status = 'waiting'
    updateData.bettingRound = ''
    updateData.pot = 0
    updateData.currentBet = 0
    updateData.minRaise = bb
    updateData.turnSeat = -1
    updateData.handNo = room.handNo + 1 // 本手结束,号让位给下一手
    updateData.players = players
    updateData.log = (room.log || []).concat([
      { ts: Date.now(), openid, type: 'action', text: logText },
      {
        ts: Date.now(),
        openid,
        type: 'hand',
        text: (winner.nick || '玩家') + ' 独赢底池 ' + room.pot + '(其余人弃牌)'
      }
    ])
  } else {
    // —— 本轮结束判定:所有能行动者都已行动且下注相等 ——
    const actors = players.filter((p) => !p.folded && !p.allIn)
    const roundDone =
      actors.length === 0 ||
      actors.every((a) => a.acted && a.bet === room.currentBet)

    if (roundDone) {
      const street = room.status
      const community = room.communityCards || []
      let newCommunity = community.slice()

      // 能行动者 <2(全 all-in/弃光):剩余公共牌全部发出,不再有下注
      const noMoreBetting = actors.length < 2

      if (street === 'river' || noMoreBetting) {
        const need = 5 - community.length
        if (need > 0) newCommunity = newCommunity.concat(await dealCards(roomId, community, need))
        updateData.status = 'showdown'
        updateData.turnSeat = -1
      } else {
        const nextStreet = NEXT_STREET[street]
        newCommunity = newCommunity.concat(
          await dealCards(roomId, community, STREET_CARDS[nextStreet])
        )
        // postflop 首个行动者:庄家之后第一个未 fold 未 allIn 者
        // (单挑时庄家=SB,postflop 由 BB 先动;excludeSelf 但循环兜底仍可指回庄家)
        const firstActor = nextActorFrom(room.dealerSeat, true)
        updateData.status = nextStreet
        updateData.turnSeat = firstActor ? firstActor.seat : -1
      }

      players.forEach((p) => {
        p.bet = 0 // 已入池
        p.acted = false
      })
      updateData.bettingRound = updateData.status
      updateData.communityCards = newCommunity
      updateData.pot = room.pot
      updateData.currentBet = 0
      updateData.minRaise = bb
      updateData.players = players
      updateData.log = (room.log || []).concat([
        { ts: Date.now(), openid, type: 'action', text: logText },
        { ts: Date.now(), openid, type: 'street', text: '进入 ' + updateData.status }
      ])
    } else {
      // 本轮继续:turnSeat 移到下一个可行动座位
      const nxt = nextActorFrom(me.seat, true)
      if (!nxt) return { ok: false, code: 'INTERNAL', error: '无下一位行动者' }
      updateData.turnSeat = nxt.seat
      updateData.players = players
      updateData.pot = room.pot
      updateData.currentBet = room.currentBet
      updateData.minRaise = room.minRaise
      updateData.log = (room.log || []).concat([
        { ts: Date.now(), openid, type: 'action', text: logText }
      ])
    }
  }

  // —— CAS 更新(§13)——
  const upd = await ROOMS.where({ _id: roomId, version }).update({ data: updateData })
  if (!upd.stats || upd.stats.updated === 0) {
    return { ok: false, code: 'CAS_FAIL', error: '状态冲突,请稍候刷新重试' }
  }

  return {
    ok: true,
    status: updateData.status || room.status,
    turnSeat: updateData.turnSeat !== undefined ? updateData.turnSeat : room.turnSeat
  }
}
