# 朋友局德州扑克 · 微信小程序

按 `技术方案.md` 分阶段实现。当前进度:**P2(发牌)**。

## 目录结构

```
myownproject/
  技术方案.md
  project.config.json          # 小程序工程配置
  miniprogram/                 # 小程序前端
    app.js / app.json / app.wxss
    config.js                  # 云环境 ID + 集合名(需填)
    sitemap.json
    pages/index/                # 首页:登录态 + 房间入口(支持分享带入 roomCode)
    pages/create/               # P1 建房配置:盲注/筹码/借款(借款默认关)
    pages/room/                 # P1 房间页:watch rooms、玩家列表、分享、离座
    services/cloud.js           # callFunction 封装
    services/actions.js         # createRoom/joinRoom/leaveRoom/startHand
    components/card/            # P2 扑克牌组件(正面/背面/空位,纯 CSS 无图片)
  cloudfunctions/
    login/                      # 返回 openid,登记 users
    createRoom/                 # P1 建房:配置 + 生成 roomCode + 初始化 rooms
    joinRoom/                   # P1 入座:分配 seat + 初始筹码
    leaveRoom/                  # P1 离座/房主踢人/转让房主
    startHand/                  # P2 开一手:CSPRNG 洗牌、私有发底牌、收盲注
  database/                     # 集合安全规则
    rooms.json hands.json handHistory.json users.json
```

## P0 验收清单

- [x] 项目骨架 + 云开发初始化
- [x] 四个集合的安全规则(§5):`hands` 仅本人可读,其余仅登录用户读、客户端写一律关闭
- [x] `login` 云函数返回稳定 openid 并 upsert `users`
- [x] 首页展示登录态(openid)与房间入口

## P1 验收清单

- [x] `createRoom`:盲注/筹码/借款配置(借款默认关,开启必填 amount+repayMultiplier),生成 roomCode,初始化 rooms 文档(对齐 §4.1,含 `lastHandSnapshot` 初始快照)
- [x] `joinRoom`:凭 roomCode 入座,分配最小可用 seat,chips=config.initialChips,幂等
- [x] `leaveRoom`:自离 / 房主踢人 / 房主转让 / 无人则关闭
- [x] 房间页 watch `rooms` 实时同步玩家列表
- [x] 分享房间号(分享卡携带 roomCode,首页预填)

## P2 验收清单

- [x] `startHand`(仅房主、仅 waiting 状态、≥2 人):crypto CSPRNG Fisher–Yates 洗牌
- [x] 每位玩家写一条 `hands` 私有文档(`ownerOpenid` 隔离,仅本人可读),每手开始前清旧记录
- [x] 收盲注:≥3 人 SB=按钮下一位 / BB=再下一位;单挑按钮=SB 对家=BB;短码被盲注推 all-in
- [x] preflop 行动从 BB 后一位开始(单挑从按钮开始);version CAS 防并发
- [x] 每手重置 `communityCards`/`revealedHands`/`endVote`;庄家按钮首手=最低 seat,此后轮转
- [x] 房间页牌桌视图:对手席(牌背/弃牌态/D 位/轮到高亮)+ 公共区 5 格 + 我的底牌大卡
- [x] 底牌获取:`hands` watch 实时推送 + 主动拉取兜底(云函数写库推送不可靠,§14.1)

## 首次使用(需手动操作)

1. 在[微信公众平台](https://mp.weixin.qq.com)注册小程序,拿到 **AppID**,替换:
   - `project.config.json` 里 `"appid"` → 你的 AppID
2. 用微信开发者工具打开本项目 → 「云开发」面板 → 开通环境,拿到 **环境 ID**,替换:
   - `miniprogram/config.js` 里 `cloudEnvId`
3. 数据库面板手动建四个集合:`rooms` / `hands` / `handHistory` / `users`
   - 导入 `database/*.json` 的安全规则:数据库面板 → 对应集合 → 权限设置 → 用「导入规则」粘贴对应 JSON(或切到「仅创建者可读写」/自定义)
4. 云函数逐个**右键 → 上传并部署:云端安装依赖**:
   - `cloudfunctions/login`
   - `cloudfunctions/createRoom`
   - `cloudfunctions/joinRoom`
   - `cloudfunctions/leaveRoom`
   - `cloudfunctions/startHand`(P2 新增)
5. 编译运行:首页输入昵称 → 「创建房间」配置盲注/筹码 → 进入房间页 → 邀请好友(分享)→ 朋友输入房间号或点分享卡「加入房间」→ 双方实时看到彼此入座。
6. P2 发牌:≥2 人后房主点「开始发牌」→ 房间页切到牌桌视图,各自看到自己的 2 张底牌(他人只见牌背),盲注已入池。

> 体验版:小程序后台「版本管理」设为体验版,仅体验成员可进,免审核免备案。

> **多人测试须知**:玩家身份 = 微信号 openid,同一微信号在模拟器/手机预览/体验版都是同一身份,无法单账号扮演两个玩家(重复加入会幂等返回、不新增座位)。测两人对局需在后台「成员管理 → 体验成员」添加另一个微信号,由对方扫码进入。详见 `技术方案.md` §14.1。

## 下一阶段

P3 下注:`action` 云函数(fold/check/call/raise/allIn 校验与轮转)+ ActionBar 按钮,能完整打一手到摊牌前的下注推进。
