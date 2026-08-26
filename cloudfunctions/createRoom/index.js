// createRoom 云函数(P1 建房)
// 校验盲注/筹码/借款配置(借款默认关,开启必填 amount+repayMultiplier),生成 roomCode,
// 初始化完整 rooms 文档(对齐技术方案 §4.1),并写入第 1 手前的 lastHandSnapshot 基准。
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const ROOMS = db.collection('rooms')

// 排除易混字符 O/0/I/1
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function genRoomCode() {
  const bytes = crypto.randomBytes(4)
  let s = ''
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return s
}

function isPosInt(n) {
  return Number.isInteger(n) && n > 0
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return { ok: false, code: 'NO_AUTH', error: '无 openid' }

  const cfg = (event && event.config) || {}
  const nick = (event && event.nick) || ''
  const avatar = (event && event.avatar) || ''

  // —— 盲注 / 筹码 ——
  const sb = Number(cfg.sb)
  const bb = Number(cfg.bb)
  const initialChips = Number(cfg.initialChips)
  if (!isPosInt(sb)) return { ok: false, code: 'BAD_SB', error: '小盲须为正整数' }
  if (!isPosInt(bb)) return { ok: false, code: 'BAD_BB', error: '大盲须为正整数' }
  if (bb < sb) return { ok: false, code: 'BB_LT_SB', error: '大盲不能小于小盲' }
  if (!isPosInt(initialChips)) return { ok: false, code: 'BAD_CHIPS', error: '初始筹码须为正整数' }

  // —— 借款配置(默认关;开启必填 amount + repayMultiplier)——
  const loanIn = cfg.loan || {}
  const loanEnabled = loanIn.enabled === true
  let loan
  if (loanEnabled) {
    const amount = Number(loanIn.amount)
    const repayMultiplier = Number(loanIn.repayMultiplier)
    if (!isPosInt(amount)) return { ok: false, code: 'BAD_LOAN_AMOUNT', error: '开启借款须填正整数借款额' }
    if (!(repayMultiplier > 0)) return { ok: false, code: 'BAD_LOAN_MULT', error: '开启借款须填还款倍率(>0)' }
    loan = {
      enabled: true,
      amount,
      cap: Number.isFinite(Number(loanIn.cap)) ? Number(loanIn.cap) : 0, // 0=不限
      repayMultiplier,
      conditions: ['chipsZero'] // 唯一条件:筹码归零方可借
    }
  } else {
    loan = {
      enabled: false,
      amount: 0,
      cap: 0,
      repayMultiplier: 1.0,
      conditions: ['chipsZero']
    }
  }

  const historyLimit = isPosInt(cfg.historyLimit) ? cfg.historyLimit : 10
  const favoriteLimit = isPosInt(cfg.favoriteLimit) ? cfg.favoriteLimit : 10
  const gameType = cfg.gameType === 'flhe' ? 'flhe' : 'nlhe'

  // —— 生成唯一 roomCode(碰撞重试)——
  let roomCode = ''
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = genRoomCode()
    const exist = await ROOMS.where({ roomCode: candidate }).limit(1).count()
    if (exist.total === 0) {
      roomCode = candidate
      break
    }
  }
  if (!roomCode) return { ok: false, code: 'CODE_GEN_FAIL', error: '房间号生成失败,请重试' }

  const now = Date.now()

  // 房主入座 seat 0
  const hostPlayer = {
    openid,
    nick,
    avatar,
    seat: 0,
    chips: initialChips,
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

  // 第 1 手前的初始快照(§9.1:建好时即各玩家初始筹码状态)
  const lastHandSnapshot = {
    handNo: 1,
    players: [{ seat: 0, chips: initialChips, loan: 0, debt: 0, repaid: 0, folded: false }],
    dealerSeat: 0,
    communityCards: []
  }

  const room = {
    roomCode,
    hostOpenid: openid,
    config: {
      sb,
      bb,
      initialChips,
      gameType,
      loan,
      historyLimit,
      favoriteLimit
    },
    status: 'waiting',
    players: [hostPlayer],
    dealerSeat: 0,
    communityCards: [],
    pot: 0,
    currentBet: 0,
    minRaise: bb,
    turnSeat: 0,
    bettingRound: 'preflop',
    handNo: 1,
    version: 0,
    lastHandSnapshot,
    endVote: {
      active: false,
      initiator: '',
      yes: [],
      no: [],
      threshold: 'all',
      triggeredHandNo: 0
    },
    revealedHands: [],
    log: [
      {
        ts: now,
        openid,
        type: 'create',
        text: '创建房间 ' + roomCode
      }
    ],
    createdAt: now
  }

  const addRes = await ROOMS.add({ data: room })
  return { ok: true, roomId: addRes._id, roomCode }
}
