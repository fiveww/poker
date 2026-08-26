// services/actions.js — 客户端动作封装(P1:房间生命周期)
// 后续 P2+ 在此追加 startHand/action/borrow/repay/proposeEnd/voteEnd/revealCards 等。
const { call } = require('./cloud.js')

// 建房:config 见技术方案 §4.1(sb/bb/initialChips/gameType/loan/historyLimit/favoriteLimit)
function createRoom(config, nick = '', avatar = '') {
  return call('createRoom', { config, nick, avatar })
}

// 入座
function joinRoom(roomCode, nick = '', avatar = '') {
  return call('joinRoom', { roomCode, nick, avatar })
}

// 离座(本人);房主可传 targetOpenid 踢人
function leaveRoom(roomId, targetOpenid) {
  return call('leaveRoom', { roomId, targetOpenid })
}

// 开一手(房主):洗牌发底牌、收盲注、状态转 preflop
function startHand(roomId) {
  return call('startHand', { roomId })
}

module.exports = {
  createRoom,
  joinRoom,
  leaveRoom,
  startHand
}
