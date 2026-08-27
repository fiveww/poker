// startHand 云函数(P2 发牌)
// 房主开局:校验 → CAS 抢 version → 移动庄家按钮 → CSPRNG 洗牌 → 发底牌
// (每人一条 hands 私有文档,仅云函数管理员可写)→ 收盲注(单挑规则)→ 状态 preflop。
// 同时重置 revealedHands / endVote / communityCards / pot 等(技术方案 §6.2)。
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const ROOMS = db.collection('rooms')
const HANDS = db.collection('hands')

const SUITS = ['s', 'h', 'd', 'c'] // 黑桃 红心 方块 梅花
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']

function freshDeck() {
  const deck = []
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s)
  return deck
}

// Fisher–Yates 洗牌,随机源用 crypto.randomInt(CSPRNG)
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1)
    const t = deck[i]
    deck[i] = deck[j]
    deck[j] = t
  }
  return deck
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return { ok: false, code: 'NO_AUTH', error: '无 openid' }

  const roomId = (event && event.roomId) || ''
  if (!roomId) return { ok: false, code: 'NO_ROOM', error: '缺少 roomId' }

  const found = await ROOMS.doc(roomId).get().catch(() => null)
  if (!found || !found.data) return { ok: false, code: 'NOT_FOUND', error: '房间不存在' }
  const room = found.data

  // 仅房主可开;waiting(首手或上一手已结算)才可开
  if (room.hostOpenid !== openid) return { ok: false, code: 'NOT_HOST', error: '仅房主可开始' }
  if (room.status !== 'waiting') return { ok: false, code: 'IN_PROGRESS', error: '当前手未结束' }

  const players = room.players || []
  if (players.length < 2) return { ok: false, code: 'NEED_PLAYERS', error: '至少 2 人才能开局' }

  const sb = room.config.sb
  const bb = room.config.bb

  // 庄家按钮移动:P1 已入座即 seat 有序。首手 dealerSeat=最低 seat;
  // 之后移到下一个活跃座位(active 玩家按 seat 环形找下一个)。单挑时按钮固定在两人间轮换。
  const seats = players.map((p) => p.seat).sort((a, b) => a - b)
  let dealerSeat
  if (room.handNo === 1 || !room.dealerMoved) {
    dealerSeat = seats[0]
  } else {
    const idx = seats.indexOf(room.dealerSeat)
    dealerSeat = seats[(idx + 1) % seats.length]
  }

  // 盲注位:常规 ≥3 人 SB=按钮下一位、BB=再下一位;单挑规则按钮=SB、对方=BB
  const n = seats.length
  const nextOf = (seat, k) => {
    const idx = seats.indexOf(seat)
    return seats[(idx + k) % n]
  }
  const sbSeat = n === 2 ? dealerSeat : nextOf(dealerSeat, 1)
  const bbSeat = n === 2 ? nextOf(dealerSeat, 1) : nextOf(dealerSeat, 2)

  const postBlind = (p, amount) => {
    const pay = Math.min(p.chips, amount)
    p.chips -= pay
    p.bet = pay
    p.totalBet = (p.totalBet || 0) + pay
    if (p.chips === 0 && pay < amount) p.allIn = true // 盲注不足被推 all-in
  }

  const bySeat = new Map(players.map((p) => [p.seat, p]))
  postBlind(bySeat.get(sbSeat), sb)
  postBlind(bySeat.get(bbSeat), bb)

  // 洗牌发底牌(每人 2 张)
  const deck = shuffle(freshDeck())
  const holeByOpenid = new Map()
  players.forEach((p) => {
    holeByOpenid.set(p.openid, [deck.pop(), deck.pop()])
  })

  // 行动顺序:preflop 从 BB 后一位开始(UTG);单挑从按钮(SB)开始
  const turnSeat = n === 2 ? sbSeat : nextOf(bbSeat, 1)

  // 当前下注基准与最小加注额
  const currentBet = bySeat.get(bbSeat).bet // = bb(除非 bb 被短码 all-in 截断)
  const minRaise = Math.max(bb, currentBet)

  const now = Date.now()

  // —— 写私有底牌(管理员 SDK,绕过安全规则)——
  // 先清掉本房间旧手记录,防跨手残留
  await HANDS.where({ roomId }).remove()
  await Promise.all(
    players.map((p) =>
      HANDS.add({
        data: {
          roomId,
          ownerOpenid: p.openid,
          holeCards: holeByOpenid.get(p.openid),
          handNo: room.handNo,
          createdAt: now
        }
      })
    )
  )

  const log = (room.log || []).concat([
    {
      ts: now,
      openid,
      type: 'hand',
      text:
        '第 ' + room.handNo + ' 手开始 · 庄家座位 ' + dealerSeat +
        ' · 小盲座位 ' + sbSeat + ' · 大盲座位 ' + bbSeat +
        (n === 2 ? '(单挑:庄家=小盲,preflop 庄家先动,postflop 大盲先动)' : '')
    }
  ])

  // —— CAS 更新房间(§13):仅当 version 未被并发改动时才落库 ——
  const upd = await ROOMS.where({ _id: roomId, version: room.version }).update({
    data: {
      status: 'preflop',
      bettingRound: 'preflop',
      handNo: room.handNo,
      dealerSeat,
      dealerMoved: true, // 首手标记:第 1 手用最低 seat,此后正常轮转
      turnSeat,
      currentBet,
      minRaise,
      pot: [...bySeat.values()].reduce((s, p) => s + p.bet, 0),
      communityCards: [],
      revealedHands: [], // 每手开始清空主动亮牌(§6.5)
      endVote: { active: false, initiator: '', yes: [], no: [], threshold: 'all', triggeredHandNo: 0 },
      players: players.map((p) => ({
        ...p,
        folded: false,
        allIn: !!p.allIn,
        bet: p.bet,
        totalBet: p.bet,
        acted: false, // P3:本轮是否已行动(BB 的 option / 加注重开行动都靠它判定)
        connected: true,
        lastSeen: now
      })),
      log,
      version: _.inc(1)
    }
  })

  if (!upd.stats || upd.stats.updated === 0) {
    return { ok: false, code: 'CAS_FAIL', error: '状态冲突,请重试' }
  }

  return {
    ok: true,
    handNo: room.handNo,
    dealerSeat,
    sbSeat,
    bbSeat,
    turnSeat
  }
}
