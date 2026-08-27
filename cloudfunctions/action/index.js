// action 云函数(P3 下注 + P4 摊牌结算 + P5 边池 + P7 房主代弃牌)
// 玩家行动:fold/check/call/raise/allIn。CAS 校验 version(§13)→ 校验轮到本人 →
// 动作合法性校验 → 更新 bet/chips/pot/currentBet/minRaise → 推进 turnSeat。
// 本轮结束判定:所有可行动玩家(未 fold 未 allIn)已行动且下注相等 → 发下一街公共牌;
// river 结束或可行动玩家 <2 → 发满 5 张后在 action 内原子完成摊牌结算(P4,§6.4):
// 内置评牌器选 7 选 5 判型 → **边池分层分配**(P5,§11:按 totalBet 升序切层,
// all-in 短码者只赢等额池层;平分余数按庄家左侧顺序补给,不冲抵欠款 §10.3)
// → 未弃牌者底牌全亮写回 revealedHands → 写 lastHandSnapshot(投票回退点,§9.1)→ 回 waiting。
// 只剩 1 人未 fold → 直接获胜(muck 不进摊牌,默认不亮牌,§6.5),同样落快照与流水。
// 每种手终都写一条 handHistory(未主动亮牌者不落底牌,§4.3 隐私约定)+ lastResult 结果面板数据。
// 房主代弃牌(forOpenid):把离线玩家标记弃牌推进桌面,完整复用 fold 的轮次推进/
// 补牌/摊牌路径(仅房主可用,目标须离线;§8 离线处理)。
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const ROOMS = db.collection('rooms')
const HANDS = db.collection('hands')
const HANDHISTORY = db.collection('handHistory')

const SUITS = ['s', 'h', 'd', 'c']
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']

const BETTING_STATES = ['preflop', 'flop', 'turn', 'river']
const NEXT_STREET = { preflop: 'flop', flop: 'turn', turn: 'river' }
const STREET_CARDS = { flop: 3, turn: 1, river: 1 }

const LOG_LIMIT = 50 // rooms.log 截断上限,防文档无限膨胀

// ==================== P4 牌型判定(内置评牌器,零依赖)====================
// 技术方案原定 pokersolver npm 库,实际实现改为内置:C(7,5)=21 组合穷举打分。
const RANK_VAL = {}
RANKS.forEach((r, i) => (RANK_VAL[r] = i + 2)) // 2..14
const VAL_NAME = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }
const valName = (v) => VAL_NAME[v] || String(v)
const CAT_TEXT = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺']

// C(n,5) 全组合下标
function comboIndices(n) {
  const res = []
  const rec = (start, cur) => {
    if (cur.length === 5) {
      res.push(cur.slice())
      return
    }
    for (let i = start; i < n; i++) {
      cur.push(i)
      rec(i + 1, cur)
      cur.pop()
    }
  }
  rec(0, [])
  return res
}

// 5 张牌打分为可比较数组 [类别, 决胜张...] 类别越大越强(8=同花顺 … 0=高牌)
function score5(cards) {
  const vals = cards.map((c) => RANK_VAL[c[0]]).sort((a, b) => b - a)
  const flush = cards.every((c) => c[1] === cards[0][1])
  let straightHigh = 0
  const uniq = [...new Set(vals)]
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0]
    else if (uniq[0] === 14 && uniq[1] === 5) straightHigh = 5 // A2345 轮子
  }
  const cnt = {}
  vals.forEach((v) => (cnt[v] = (cnt[v] || 0) + 1))
  const groups = Object.entries(cnt)
    .map(([v, c]) => ({ v: +v, c }))
    .sort((a, b) => b.c - a.c || b.v - a.v)
  if (flush && straightHigh) return [8, straightHigh]
  if (groups[0].c === 4) return [7, groups[0].v, groups[1].v]
  if (groups[0].c === 3 && groups[1].c === 2) return [6, groups[0].v, groups[1].v]
  if (flush) return [5].concat(vals)
  if (straightHigh) return [4, straightHigh]
  if (groups[0].c === 3) return [3, groups[0].v, groups[1].v, groups[2].v]
  if (groups[0].c === 2 && groups[1].c === 2) return [2, groups[0].v, groups[1].v, groups[2].v]
  if (groups[0].c === 2) return [1, groups[0].v, groups[1].v, groups[2].v, groups[3].v]
  return [0].concat(vals)
}

function cmpScore(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0)
    if (d) return d
  }
  return 0
}

function describe(score) {
  const cat = score[0]
  if (cat === 8) return score[1] === 14 ? '皇家同花顺' : '同花顺(' + valName(score[1]) + ' 高)'
  if (cat === 7) return '四条 ' + valName(score[1])
  if (cat === 6) return '葫芦(' + valName(score[1]) + ' 带 ' + valName(score[2]) + ')'
  if (cat === 4) return '顺子(' + valName(score[1]) + ' 高)'
  if (cat === 3) return '三条 ' + valName(score[1])
  if (cat === 2) return '两对 ' + valName(score[1]) + ' 和 ' + valName(score[2])
  if (cat === 1) return '一对 ' + valName(score[1])
  if (cat === 0) return '高牌 ' + valName(score[1])
  return CAT_TEXT[cat]
}

// 5~7 张里选最强 5 张(公共牌 5 张 + 底牌 2 张 → C(7,5)=21 次)
function bestOf(cards) {
  let best = null
  comboIndices(cards.length).forEach((idx) => {
    const s = score5(idx.map((i) => cards[i]))
    if (!best || cmpScore(s, best.score) > 0) best = { score: s }
  })
  best.text = describe(best.score)
  return best
}

// ==================== 共用小工具 ====================

// 本房间全部私有底牌 Map(openid → holeCards),按请求缓存(ctx):
// 同一次调用里「发补牌排除」和「摊牌评牌」共用这一次查询,减少串行库操作防超时。
function loadHandMapOnce(ctx, roomId) {
  if (!ctx.handMapPromise) {
    ctx.handMapPromise = HANDS.where({ roomId })
      .get()
      .then((res) => new Map(res.data.map((d) => [d.ownerOpenid, d.holeCards || []])))
      .catch(() => new Map())
  }
  return ctx.handMapPromise
}

// 从「未发出的牌」里随机抽 n 张(CSPRNG):排除所有人底牌(hands 私有文档)+ 已亮公共牌
async function dealCards(ctx, roomId, community, n) {
  const used = new Set()
  ;(community || []).forEach((c) => used.add(c))
  const handMap = await loadHandMapOnce(ctx, roomId)
  handMap.forEach((cards) => cards.forEach((c) => used.add(c)))
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

// 上一手结算后、按钮移动前的快照(投票回退点,§9.1)
function makeSnapshot(handNo, players, dealerSeat, communityCards) {
  return {
    handNo,
    players: players.map((p) => ({
      seat: p.seat,
      chips: p.chips,
      loan: p.loan || 0,
      debt: p.debt || 0,
      repaid: p.repaid || 0,
      folded: !!p.folded
    })),
    dealerSeat,
    communityCards
  }
}

// 取当前手的动作流水切片:最近一条「第 N 手开始」之后的 log 条目
function sliceHandActions(log) {
  const arr = log || []
  let start = -1
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].type === 'hand' && /开始/.test(arr[i].text || '')) {
      start = i
      break
    }
  }
  return arr.slice(start + 1).map((e) => ({ ts: e.ts, openid: e.openid, text: e.text }))
}

// 客户端入口:快速校验 + 统一捕获业务异常。
// -504002(执行失败)通常 = 超时或未捕获异常;在此归一后前端 toast 能看到真实原因,
// 云端日志也有完整 stack(此前摊牌结算抛错时客户端只能看到笼统的 fail)。
exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { ok: false, code: 'NO_AUTH', error: '无 openid' }
  try {
    return await doAction(event)
  } catch (e) {
    console.error('action failed', event && event.roomId, e)
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      error: '服务器异常,请重试(' + ((e && e.message) || String(e)) + ')'
    }
  }
}

async function doAction(event) {
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
  const fnCtx = {} // 本次请求内 hands 查询缓存(见 loadHandMapOnce)

  const found = await ROOMS.doc(roomId).get().catch(() => null)
  if (!found || !found.data) return { ok: false, code: 'NOT_FOUND', error: '房间不存在' }
  const room = found.data

  // —— 状态校验 ——
  if (BETTING_STATES.indexOf(room.status) === -1) {
    return { ok: false, code: 'NOT_BETTING', error: '当前不在下注阶段' }
  }
  const players = (room.players || []).map((p) => ({ ...p }))
  let me = players.find((p) => p.openid === openid)
  if (!me) return { ok: false, code: 'NOT_IN_ROOM', error: '你不在此房间' }

  // —— 房主代弃牌(§8 离线处理):event.forOpenid 指定目标玩家 ——
  // 仅房主可用;目标须离线(!connected 或心跳超时)。改绑 me 后,
  // fold 走下方完全相同的结算路径(轮次推进/补牌/摊牌/快照),无重复逻辑。
  const OFFLINE_MS = 90 * 1000
  if (event.forOpenid && event.forOpenid !== openid) {
    if (room.hostOpenid !== openid) {
      return { ok: false, code: 'FORBIDDEN', error: '仅房主可代为操作' }
    }
    const target = players.find((p) => p.openid === event.forOpenid)
    if (!target) return { ok: false, code: 'NOT_IN_ROOM', error: '该玩家不在房间' }
    const offline = !target.connected || Date.now() - (target.lastSeen || 0) > OFFLINE_MS
    if (!offline) return { ok: false, code: 'TARGET_ONLINE', error: '对方在线,不能代为弃牌' }
    me = target
  }

  const actorName =
    event.forOpenid && event.forOpenid !== openid ? me.nick || '对方' : '你'
  if (room.turnSeat !== me.seat) {
    return { ok: false, code: 'NOT_YOUR_TURN', error: '还没轮到' + actorName }
  }
  if (me.folded || me.allIn) {
    return { ok: false, code: 'CANNOT_ACT', error: actorName + ' 本手无需行动' }
  }

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
    const forcedMark =
      event.forOpenid && event.forOpenid !== openid ? '(房主代弃,已离线)' : ''
    logText = (me.nick || '玩家') + ' 弃牌' + forcedMark
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
  // 手终产出(两种路径统一):开奖流水文档 + 赢家名单,须等 CAS 成功后再落库/返回
  let historyDoc = null
  let handWinners = []
  let sidePotDocs = [] // P5:本手各池(主池/边池)明细,落 handHistory.sidePots

  // —— 结算通用收尾(§6.3.6 / §6.4 第 7~8 步):清桌、快照、结果面板、日志 ——
  // chips 此刻必须已是派池后状态;totalWinByOpenid 用于记每手盈亏 delta
  const finishHand = (totalWinByOpenid, potTotal, communityNow, lines, logTextHand) => {
    players.forEach((p) => {
      p.bet = 0
      p.acted = false
    })
    const now = Date.now()
    const revealedList = (room.revealedHands || []).slice()
    updateData.status = 'waiting'
    updateData.bettingRound = ''
    updateData.pot = 0
    updateData.currentBet = 0
    updateData.minRaise = bb
    updateData.turnSeat = -1
    updateData.handNo = room.handNo + 1 // 本手结束,号让位给下一手
    updateData.players = players
    updateData.communityCards = communityNow // 保留到大厅结果面板展示,startHand 时再清
    // 纯对象字段用 _.set 整体替换:CloudBase 会把裸对象展开成子路径写入,
    // 上个值若是 null(startHand 重置过)就会报 Cannot create field 'xxx'
    updateData.lastHandSnapshot = _.set(
      makeSnapshot(room.handNo, players, room.dealerSeat, communityNow)
    )
    const winMap = totalWinByOpenid
    historyDoc = {
      roomId,
      handNo: room.handNo,
      ts: now,
      players: players.map((p) => {
        const pub = revealedList.find((r) => r.openid === p.openid) // 仅公开亮出的牌才落库(隐私约定 §4.3)
        return {
          openid: p.openid,
          nick: p.nick || '',
          seat: p.seat,
          holeCards: pub ? pub.holeCards : [],
          holeRevealed: !!pub,
          finalChips: p.chips,
          delta: (winMap[p.openid] || 0) - (p.totalBet || 0),
          loan: p.loan || 0,
          debt: p.debt || 0,
          repaid: p.repaid || 0,
          folded: !!p.folded
        }
      }),
      communityCards: communityNow,
      sidePots: [],
      actions: sliceHandActions(room.log),
      favorite: false,
      isFinal: false
    }
    updateData.lastResult = _.set({
      handNo: room.handNo,
      title: '第 ' + room.handNo + ' 手结束',
      lines,
      potTotal,
      community: communityNow,
      reveals: revealedList.map((r) => ({
        openid: r.openid,
        nick: r.nick || '',
        holeCards: r.holeCards || [],
        hand: r.hand || ''
      })),
      ts: now
    })
    updateData.log = (room.log || []).slice(-LOG_LIMIT).concat([
      { ts: now, openid, type: 'action', text: logText },
      { ts: now, openid, type: 'hand', text: logTextHand }
    ])
  }

  // —— 只剩 1 人未 fold:直接获胜回 waiting(§6.3.6)。
  // 赢家底牌默认 muck(可主动 revealCards 自亮);桌面公共牌补发至完整 5 张
  // 进结果面板展示(仅展示用,不影响已结算的输赢)。
  if (survivors.length === 1) {
    const winner = survivors[0]
    const potAtEnd = room.pot
    winner.chips += potAtEnd // 分池不冲抵欠款(定版变更 §10.3)
    const communityNow = room.communityCards || []
    const need = 5 - communityNow.length
    const fullBoard =
      need > 0 ? communityNow.concat(await dealCards(fnCtx, roomId, communityNow, need)) : communityNow.slice()
    const line =
      (winner.nick || '玩家') + ' 独赢底池 ' + potAtEnd + '(其余人弃牌)'
    finishHand(
      { [winner.openid]: potAtEnd },
      potAtEnd,
      fullBoard,
      [line],
      line
    )
    handWinners = [
      { openid: winner.openid, nick: winner.nick || '', hand: '', potShare: potAtEnd }
    ]
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
        if (need > 0) {
          newCommunity = newCommunity.concat(await dealCards(fnCtx, roomId, community, need))
        }

        // —— P5 边池摊牌结算(action 内原子完成,§6.4 + §11):
        // 评牌 → 按 totalBet 升序切层建主池/边池 → 逐池分配 → 回 waiting ——
        const handMap = await loadHandMapOnce(fnCtx, roomId)
        const alive = players.filter((p) => !p.folded)
        const missing = alive.some((p) => (handMap.get(p.openid) || []).length !== 2)
        if (missing) return { ok: false, code: 'INTERNAL', error: '底牌缺失,无法摊牌' }

        const evals = alive.map((p) => {
          const seven = handMap.get(p.openid).concat(newCommunity)
          return { p: p, best: bestOf(seven) }
        })

        const potAtEnd = room.pot

        // 边池切层(§11):以各未弃牌玩家的总投入为层界升序切层。
        // 每层金额 = 全体玩家(含弃牌者,min 截断到层界)在该层的增量;
        // 投入 ≥ 层界的未弃牌者才有资格争这一层 → all-in 短码者只赢等额部分。
        const levels = [...new Set(alive.map((p) => p.totalBet || 0).filter((v) => v > 0))].sort(
          (a, b) => a - b
        )
        let prevLevel = 0
        const pots = []
        levels.forEach((lv) => {
          let amount = 0
          players.forEach((p) => {
            amount += Math.max(0, Math.min(p.totalBet || 0, lv) - prevLevel)
          })
          if (amount > 0) {
            pots.push({
              level: Number.isFinite(lv) ? lv : -1,
              amount,
              eligible: alive.filter((p) => (p.totalBet || 0) >= lv)
            })
          }
          prevLevel = lv
        })
        // 防御性兜底:正常下注流程里切层总额必等于底池;若异常为空则退化为单池
        if (!pots.length) {
          pots.push({ level: -1, amount: potAtEnd, eligible: alive.slice() })
        }

        const orderKey = (seat) =>
          (seats.indexOf(seat) - seats.indexOf(room.dealerSeat) + n) % n

        // 逐池分配:平分,余数按「庄家左侧起环序」逐一补给;
        // 分池只加 chips 不冲抵欠款(定版变更 §10.3:自动还款取消,
        // 欠款由手动 repay / 游戏结束强制结清)
        const winMap = {}
        const aggByOpenid = {}
        sidePotDocs = []
        pots.forEach((pot, pi) => {
          let top = null
          pot.eligible.forEach((pp) => {
            const e = evals.find((ev) => ev.p.openid === pp.openid)
            if (!top || cmpScore(e.best.score, top.score) > 0) top = e.best
          })
          const ws = pot.eligible
            .map((pp) => evals.find((ev) => ev.p.openid === pp.openid))
            .filter((e) => cmpScore(e.best.score, top.score) === 0)
          ws.sort((a, b) => orderKey(a.p.seat) - orderKey(b.p.seat))
          const share = Math.floor(pot.amount / ws.length)
          let rem = pot.amount - share * ws.length
          const winnerNames = []
          ws.forEach((w) => {
            const got = share + (rem > 0 ? 1 : 0)
            if (rem > 0) rem--
            w.p.chips += got
            winMap[w.p.openid] = (winMap[w.p.openid] || 0) + got
            if (!aggByOpenid[w.p.openid]) {
              aggByOpenid[w.p.openid] = {
                openid: w.p.openid,
                nick: w.p.nick || '',
                best: w.best,
                share: 0
              }
            }
            aggByOpenid[w.p.openid].share += got
            winnerNames.push(w.p.nick || '')
          })
          sidePotDocs.push({
            index: pi + 1,
            level: pot.level,
            amount: pot.amount,
            winners: ws.map((w) => w.p.openid),
            label:
              (pi === 0 ? '主池' : '边池' + pi) + ' ' + pot.amount +
              (winnerNames.length > 1 ? '(平分)' : '') + ' → ' + winnerNames.join('、')
          })
        })

        // 开牌(用户定版):摊牌时所有未弃牌玩家的底牌全部写回公开 revealedHands,
        // 各自带评出的牌型文案;已弃牌者仍默认不亮、可自亮(§6.5)
        const handTextByOpenid = {}
        evals.forEach((e) => (handTextByOpenid[e.p.openid] = e.best.text))
        const revealedList = (room.revealedHands || []).slice()
        alive.forEach((p) => {
          if (!revealedList.some((r) => r.openid === p.openid)) {
            revealedList.push({
              openid: p.openid,
              nick: p.nick || '玩家',
              holeCards: handMap.get(p.openid),
              handNo: room.handNo,
              hand: handTextByOpenid[p.openid] || ''
            })
          }
        })
        room.revealedHands = revealedList

        // 结果行:先列各池归属(P5),再按庄家左侧环序列出每人牌型与赢得合计
        const lines = []
        sidePotDocs.forEach((sp) => lines.push(sp.label))
        evals
          .slice()
          .sort((a, b) => orderKey(a.p.seat) - orderKey(b.p.seat))
          .forEach((e) => {
            const base = (e.p.nick || '玩家') + ':「' + e.best.text + '」'
            const won = winMap[e.p.openid] || 0
            lines.push(won > 0 ? base + ' 赢得 ' + won : base)
          })
        finishHand(winMap, potAtEnd, newCommunity, lines, lines.join(';'))
        updateData.revealedHands = revealedList
        handWinners = Object.values(aggByOpenid).map((aw) => ({
          openid: aw.openid,
          nick: aw.nick,
          hand: aw.best.text,
          potShare: aw.share
        }))
      } else {
        const nextStreet = NEXT_STREET[street]
        newCommunity = newCommunity.concat(
          await dealCards(fnCtx, roomId, community, STREET_CARDS[nextStreet])
        )
        // postflop 首个行动者:庄家之后第一个未 fold 未 allIn 者
        // (单挑时庄家=SB,postflop 由 BB 先动;excludeSelf 但循环兜底仍可指回庄家)
        const firstActor = nextActorFrom(room.dealerSeat, true)

        players.forEach((p) => {
          p.bet = 0 // 已入池
          p.acted = false
        })
        updateData.status = nextStreet
        updateData.turnSeat = firstActor ? firstActor.seat : -1
        updateData.bettingRound = nextStreet
        updateData.communityCards = newCommunity
        updateData.pot = room.pot
        updateData.currentBet = 0
        updateData.minRaise = bb
        updateData.players = players
        updateData.log = (room.log || []).slice(-LOG_LIMIT).concat([
          { ts: Date.now(), openid, type: 'action', text: logText },
          { ts: Date.now(), openid, type: 'street', text: '进入 ' + nextStreet }
        ])
      }
    } else {
      // 本轮继续:turnSeat 移到下一个可行动座位
      const nxt = nextActorFrom(me.seat, true)
      if (!nxt) return { ok: false, code: 'INTERNAL', error: '无下一位行动者' }
      updateData.turnSeat = nxt.seat
      updateData.players = players
      updateData.pot = room.pot
      updateData.currentBet = room.currentBet
      updateData.minRaise = room.minRaise
      updateData.log = (room.log || []).slice(-LOG_LIMIT).concat([
        { ts: Date.now(), openid, type: 'action', text: logText }
      ])
    }
  }

  // —— CAS 更新(§13):where 条件含 version,更新同时递增 version 防并发/重放 ——
  const upd = await ROOMS.where({ _id: roomId, version }).update({
    data: Object.assign({ version: _.inc(1) }, updateData)
  })
  if (!upd.stats || upd.stats.updated === 0) {
    return { ok: false, code: 'CAS_FAIL', error: '状态冲突,请稍候刷新重试' }
  }

  // —— 手终流水落库(CAS 成功后才写,失败不影响房间状态)——
  if (historyDoc) {
    historyDoc.winners = handWinners
    historyDoc.sidePots = sidePotDocs // P5:主池/边池明细
    await HANDHISTORY.add({ data: historyDoc }).catch((e) =>
      console.error('handHistory write failed', e)
    )
  }

  return {
    ok: true,
    status: updateData.status || room.status,
    turnSeat: updateData.turnSeat !== undefined ? updateData.turnSeat : room.turnSeat,
    winners: handWinners
  }
}
