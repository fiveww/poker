// login 云函数:返回稳定 openid(P0 身份打通)
// 顺带 upsert users 文档,记录昵称/头像(由客户端传入,空则留空)。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  const { nick, avatar } = event || {}

  try {
    const users = db.collection('users')
    const existing = await users.where({ _openid: openid }).limit(1).get()
    if (existing.data.length === 0) {
      await users.add({
        data: {
          _openid: openid,
          nick: nick || '',
          avatar: avatar || '',
          createdAt: db.serverDate()
        }
      })
    } else if (nick || avatar) {
      const id = existing.data[0]._id
      const patch = {}
      if (nick) patch.nick = nick
      if (avatar) patch.avatar = avatar
      await users.doc(id).update({ data: patch })
    }
  } catch (e) {
    // users 写入失败不应阻塞登录
    console.warn('login: users upsert failed', e)
  }

  return { ok: true, openid }
}
