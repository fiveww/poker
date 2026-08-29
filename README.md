# 德扑 · 微信小程序

按 `技术方案.md` 分阶段实现。当前进度:**P0–P9 全部交付**(发牌、下注、摊牌结算、边池、借款、断线重连、投票结束、牌局回看)。

## 目录结构

```
poker/
  技术方案.md
  规则书.md                     # 面向玩家的游戏规则说明
  project.config.json          # 小程序工程配置
  miniprogram/                 # 小程序前端
    app.js / app.json / app.wxss
    config.js                  # 云环境 ID + 集合名(需填)
    sitemap.json
    pages/index/                # 首页:登录态 + 房间入口(支持分享带入 roomCode)
    pages/create/               # 建房配置:盲注/筹码/借款(借款默认关)
    pages/room/                 # 房间页 + 牌桌视图 + 行动条 + 借款卡 + 投票/结果面板(watch rooms、分享、离座)
    pages/history/              # 历史对局:本机曾加入房间列表,一键重新加入(失效自动清理)
    pages/replay/               # 牌局回看:动作步进/自动播放重放 + 收藏
    services/cloud.js           # callFunction 封装
    services/actions.js         # 全部动作:入座/发牌/下注/借款/投票/亮牌等
    services/history.js         # 本地房间历史(wx storage,LRU 上限 20)
    components/card/            # 扑克牌组件(正面/背面/空位,纯 CSS 无图片;T 显示为 10)
  cloudfunctions/
    login/                      # 返回 openid,登记 users
    createRoom/                 # 建房:配置 + 生成 roomCode + 初始化 rooms(含初始快照)
    joinRoom/                   # 入座:分配 seat + 初始筹码;已在座幂等回桌
    leaveRoom/                  # 离座/房主踢人/转让房主
    startHand/                  # 开一手:CSPRNG 洗牌、私有发底牌、收盲注、移庄家按钮
    action/                     # 下注:fold/check/call/raise/allin 校验与轮转推进;发公共牌;
                                #   摊牌原子结算(内置评牌器 + 边池分层 + 写快照/结果面板);
                                #   支持房主代离线玩家弃牌(forOpenid)
    borrow/ repay/              # 借款(chips 归零方可借、cap 上限、debt=loan×倍率)/ 手动还款
    syncState/                  # 重连拉全量 + 心跳刷新在线状态
    proposeEnd/ voteEnd/        # 投票结束整局:记票 → 全员同意回退上一手快照
    endGame/                    # 终局清算:强制还款(余额可为负)、写终局 history、closed
    favoriteHand/               # 收藏/取消收藏(超上限挤掉最早)
    revealCards/                # 主动亮牌(统一只在结算后展示)
  database/                     # 集合安全规则
    rooms.json hands.json handHistory.json users.json
```

## 功能总览(验收清单)

### P0 环境
- [x] 项目骨架 + 云开发初始化
- [x] 四个集合的安全规则(§5):`hands` 仅本人可读,其余仅登录用户读、客户端写一律关闭
- [x] `login` 云函数返回稳定 openid 并 upsert `users`
- [x] 首页展示登录态(openid)与房间入口

### P1 房间
- [x] `createRoom`:盲注/筹码/借款配置(借款默认关,开启必填 amount+repayMultiplier),生成 roomCode,初始化 rooms 文档(对齐 §4.1,含 `lastHandSnapshot` 初始快照)
- [x] `joinRoom`:凭 roomCode 入座,分配最小可用 seat,chips=config.initialChips,幂等
- [x] `leaveRoom`:自离 / 房主踢人 / 房主转让 / 无人则关闭
- [x] 房间页 watch `rooms` 实时同步玩家列表
- [x] 分享房间号(分享卡携带 roomCode,首页预填)

### P2 发牌
- [x] `startHand`(仅房主、仅 waiting 状态、≥2 人):crypto CSPRNG Fisher–Yates 洗牌
- [x] 每位玩家写一条 `hands` 私有文档(`ownerOpenid` 隔离,仅本人可读),每手开始前清旧记录
- [x] 收盲注:≥3 人 SB=按钮下一位 / BB=再下一位;单挑按钮=SB 对家=BB;短码被盲注推 all-in
- [x] preflop 行动从 BB 后一位开始(单挑从按钮开始);version CAS 防并发
- [x] 每手重置 `communityCards`/`revealedHands`/`endVote`;庄家按钮首手=最低 seat,此后轮转
- [x] 房间页牌桌视图:对手席(牌背/弃牌态/D 位/轮到高亮)+ 公共区 5 格 + 我的底牌大卡
- [x] 底牌获取:`hands` watch 实时推送 + 主动拉取兜底(云函数写库推送不可靠,§14.1)

### P3 下注
- [x] `action` 云函数:version CAS 防并发 / openid == turnSeat 校验(§6.3)
- [x] 动作校验:check 须无人下注;raise ≥ currentBet+minRaise(不足额仅允许纯 all-in);call 短码自动 all-in 截断;allIn 一键全下
- [x] 完整加注重开行动权(其他玩家 acted 清零)并更新 minRaise;短码 all-in 不重开
- [x] 本轮结束判定 → 发 flop(3 张)/turn/river 公共牌(排除已发底牌,CSPRNG 抽取),重置 bet/currentBet/minRaise
- [x] 只剩 1 人未 fold → 直接获胜默认 muck:赢家拿底池、回 `waiting`、handNo++,可立刻开下一手
- [x] ActionBar UI:弃牌/看牌/跟注/加注(滑杆+最小/半池/满池/全下预设)/全下;非本人行动显示「等待 XX」
- [x] 行动顺序符合真实规则(模拟测试验证):≥3 人 preflop 从大盲后一位开始、postflop 每轮从小盲(庄家下一位)开始;**单挑 preflop 庄家(兼小盲)先动、postflop 大盲先动**
- [x] 界面标注小盲/大盲身份(单挑时庄家同时显示 D + 小盲),行动条下有「能否看牌」的规则提示

### P4 结算
- [x] 摊牌在 `action` 内原子完成:内置评牌器(7 选 5 共 21 组合穷举,零依赖替代 pokersolver)打分比牌
- [x] 结算写 `handHistory` + `lastHandSnapshot`(投票回退点)+ `lastResult` 结果面板,状态回 `waiting`
- [x] 开牌定版:摊牌全亮未弃牌者底牌(附牌型文案);弃牌独赢默认 muck,公共牌补发 5 张仅作展示
- [x] 主动亮牌 `revealCards`:手中途只写私有标记,**统一结算后**随结果面板公开展示

### P5 边池
- [x] 分层切池(§11):按各未弃牌者 totalBet 升序分层,余数按庄家左侧环序补给;等额深码退化为单池
- [x] `handHistory.sidePots` 落各池明细;结果面板先列各池归属、再列每人牌型与总赢额

### P6 借款
- [x] `borrow`:enabled + chips==0 + cap 校验;金额固定 config.loan.amount;`debt = round(loan × 倍率)`
- [x] `repay`:手动还款,缺省全额结清;**分池不自动冲抵欠款**(§10.3 定版)
- [x] endGame / 投票通过时强制还款:`chips -= debt`,余额可为负照扣
- [x] 房间页借款卡 + 牌桌欠款行显示

### P7 重连
- [x] `syncState` 拉全量(rooms + 本人 hands)+ 心跳(20s)刷新在线状态;离线阈值 90s
- [x] 断线 `watch` 自动续接 + onError 兜底拉取;onShow 拉一次、onHide 停表
- [x] `joinRoom` 幂等回桌:已在座成员任意非 closed 状态可直接回到进行中的牌桌
- [x] 房主代离线玩家弃牌(action `forOpenid`,完整复用 fold 结算路径);投票对离线玩家豁免

### P8 投票结束
- [x] `proposeEnd`/`voteEnd`:每人一票,**全员同意**(活跃玩家、离线豁免)才通过
- [x] 通过后当前手作废,按 `lastHandSnapshot` 回退到「上一手结算后、按钮移动前」,再 `endGame` 清算
- [x] 房主 waiting 态可直捷 `endGame`,同一套清算语义;终局写 `isFinal=true` 的 handHistory

### P9 回看
- [x] `handHistory` 列表(最近 historyLimit 条)+ 收藏(超 favoriteLimit 云端挤掉最早)
- [x] `pages/replay` 重放视图:动作逐条步进/自动播放,公共牌随街亮出,摊牌展示赢家与已公开底牌
- [x] isFinal 终局记录直接展开余额清单

## 首次使用(需手动操作)

1. 在[微信公众平台](https://mp.weixin.qq.com)注册小程序,拿到 **AppID**,替换:
   - `project.config.json` 里 `"appid"` → 你的 AppID
2. 用微信开发者工具打开本项目 → 「云开发」面板 → 开通环境,拿到 **环境 ID**,替换:
   - `miniprogram/config.js` 里 `cloudEnvId`
3. 数据库面板手动建四个集合:`rooms` / `hands` / `handHistory` / `users`
   - 导入 `database/*.json` 的安全规则:数据库面板 → 对应集合 → 权限设置 → 用「导入规则」粘贴对应 JSON(或切到「仅创建者可读写」/自定义)
4. 云函数逐个**右键 → 上传并部署:云端安装依赖**(共 14 个,漏传报 -501000 FUNCTION_NOT_FOUND):
   - `login` `createRoom` `joinRoom` `leaveRoom`
   - `startHand` `action`
   - `borrow` `repay` `syncState`
   - `proposeEnd` `voteEnd` `endGame`
   - `favoriteHand` `revealCards`
5. 编译运行:首页输入昵称 → 「创建房间」配置盲注/筹码(可选开启借款)→ 进入房间页 → 邀请好友(分享)→ 朋友输入房间号或点分享卡「加入房间」→ 双方实时看到彼此入座。
6. 开牌:≥2 人后房主点「开始发牌」→ 各自看到自己的 2 张底牌(他人只见牌背),盲注入池 → 轮到本人时底部出现动作条(弃牌/看牌/跟注/加注/全下)→ 下注轮结束自动发公共牌。
7. 结算:打到河牌自动摊牌评牌分池,大厅显示「上局结果」面板(公共牌 + 赢家牌型 + 已亮底牌);只剩一人未弃牌则直接获胜(默认不亮牌)。
8. 周边功能:筹码归零可借款(若房主开启)、「投票结束」发起全员表决、每手结算后可在回看页翻最近局/收藏/重放。

> 体验版:小程序后台「版本管理」设为体验版,仅体验成员可进,免审核免备案。

> **多人测试须知**:玩家身份 = 微信号 openid,同一微信号在模拟器/手机预览/体验版都是同一身份,无法单账号扮演两个玩家(重复加入会幂等返回、不新增座位)。测两人对局需在后台「成员管理 → 体验成员」添加另一个微信号,由对方扫码进入。详见 `技术方案.md` §14.1。
