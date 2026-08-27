// services/actions.js — 客户端动作封装
// P1 房间生命周期 → P3 行动 → P6 借款 → P7 重连 → P8 投票/结束 → P9 收藏。
const { call } = require('./cloud.js')

// 建房:config 见技术方案 §4.1(sb/bb/initialChips/gameType/loan/historyLimit/favoriteLimit)
function createRoom(config, nick = '', avatar = '') {
  return call('createRoom', { config, nick, avatar })
}

// 入座(P7:已在座时牌局进行中也放行回桌)
function joinRoom(roomCode, nick = '', avatar = '') {
  return call('joinRoom', { roomCode, nick, avatar })
}

// 离座(本人);房主可传 targetOpenid 踢人(仅 waiting;进行中请用代弃牌)
function leaveRoom(roomId, targetOpenid) {
  return call('leaveRoom', { roomId, targetOpenid })
}

// 开一手(房主):洗牌发底牌、收盲注、状态转 preflop
function startHand(roomId) {
  return call('startHand', { roomId })
}

// 玩家行动(P3):version 走房间文档 CAS;raise 的 amount = 加注到的总额(非增量)。
// extra:forOpenid(P7 房主把离线玩家代弃牌)
function doAction(roomId, version, action, amount, extra) {
  return call('action', Object.assign({ roomId, version, action, amount }, extra || {}))
}

// 借款(P6):条件与金额全部由云端校验(config.loan)
function borrow(roomId) {
  return call('borrow', { roomId })
}

// 手动还款(P6):amount 缺省 = 全额结清 min(chips, debt)
function repay(roomId, amount) {
  return call('repay', { roomId, amount })
}

// 重连拉全量 + 心跳(P7):返回 { room, myHand }
function syncState(roomId) {
  return call('syncState', { roomId })
}

// 发起结束投票(P8)
function proposeEnd(roomId) {
  return call('proposeEnd', { roomId })
}

// 投票(P8):agree=true 同意 / false 反对
function voteEnd(roomId, agree) {
  return call('voteEnd', { roomId, agree })
}

// 房主直接结束整局并清算(P8)
function endGame(roomId) {
  return call('endGame', { roomId })
}

// 收藏/取消收藏一手记录(P9)
function favoriteHand(roomId, historyId, favorite) {
  return call('favoriteHand', { roomId, historyId, favorite })
}

// 主动亮本人底牌(§6.5):muck 赢家/弃牌秀牌/摊牌未赢者补亮
function revealCards(roomId) {
  return call('revealCards', { roomId })
}

module.exports = {
  createRoom,
  joinRoom,
  leaveRoom,
  startHand,
  doAction,
  borrow,
  repay,
  syncState,
  proposeEnd,
  voteEnd,
  endGame,
  favoriteHand,
  revealCards
}
