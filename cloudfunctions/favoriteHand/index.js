// favoriteHand 云函数(P9 收藏/取消收藏,§4.3)
// 收藏上限 config.favoriteLimit(默认 10):超限时新收藏挤掉最早的一条收藏。
// 客户端读走安全规则(auth.openid != null),写只经云函数管理员 SDK。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const ROOMS = db.collection('rooms')
const HANDHISTORY = db.collection('handHistory')

exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { ok: false, code: 'NO_AUTH', error: '无 openid' }
  try {
    return await fav(event, openid)
  } catch (e) {
    console.error('favoriteHand failed', event && event.historyId, e)
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      error: '服务器异常,请重试(' + ((e && e.message) || String(e)) + ')'
    }
  }
}

async function fav(event, openid) {
  const historyId = (event && event.historyId) || ''
  if (!historyId) return { ok: false, code: 'BAD_REQ', error: '缺少记录 id' }

  const found = await HANDHISTORY.doc(historyId).get().catch(() => null)
  if (!found || !found.data) return { ok: false, code: 'NOT_FOUND', error: '记录不存在' }
  const doc = found.data

  // 目标状态:显式指定或取反
  const next = typeof (event && event.favorite) === 'boolean' ? event.favorite : !doc.favorite
  if (next === !!doc.favorite) return { ok: true, favorite: next }

  if (next) {
    // 收藏:查上限、必要时挤掉最早一条已有收藏(≠本条)
    let limit = 10
    try {
      const r = await ROOMS.doc(doc.roomId).get()
      if (r.data && r.data.config && Number(r.data.config.favoriteLimit) > 0) {
        limit = Number(r.data.config.favoriteLimit)
      }
    } catch (e) {
      /* 房间可能已删,沿用默认 */
    }

    const favs = await HANDHISTORY.where({ roomId: doc.roomId, favorite: true })
      .orderBy('ts', 'asc')
      .limit(limit + 1)
      .get()

    if (favs.data.length >= limit) {
      const evict = favs.data.find((d) => d._id !== historyId) // ts asc → 最先入藏者
      if (evict) {
        await HANDHISTORY.doc(evict._id).update({ data: { favorite: false } })
      }
    }
  }

  await HANDHISTORY.doc(historyId).update({ data: { favorite: next } })
  return { ok: true, favorite: next }
}
