// 云开发环境配置
// 首次使用前:在微信开发者工具「云开发」面板开通环境,把下面的 envId 换成你的环境 ID。
// project.config.json 的 appid 也需替换为你注册的小程序 appid(目前是占位 touristappid)。
module.exports = {
  cloudEnvId: 'cloudbase-d2g0cifz1d16204fe', // TODO: 替换为真实云开发环境 ID
  // 集合名
  collections: {
    rooms: 'rooms',
    hands: 'hands',
    handHistory: 'handHistory',
    users: 'users'
  }
}
