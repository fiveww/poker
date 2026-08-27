// services/history.js — 本地房间历史(P2+)
// 仅存本机(wx storage),上限 20 条 LRU;新条目置顶,按 roomId 去重。
// 失效条目(房间已关/不存在)由历史页在加入失败时调用 remove 清理。
const KEY = 'poker_room_history'
const LIMIT = 20

function list() {
  const v = wx.getStorageSync(KEY)
  return Array.isArray(v) ? v : []
}

function add(roomId, roomCode) {
  if (!roomId || !roomCode) return
  const items = list().filter((it) => it.roomId !== roomId)
  items.unshift({ roomId, roomCode, ts: Date.now() })
  wx.setStorageSync(KEY, items.slice(0, LIMIT))
}

function remove(roomId) {
  wx.setStorageSync(KEY, list().filter((it) => it.roomId !== roomId))
}

module.exports = { list, add, remove }
