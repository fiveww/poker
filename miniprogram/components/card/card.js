// components/card — 扑克牌(P2)
// 纯 CSS 绘制卡面,无图片依赖;后续换雪碧图只需改本组件样式。
// card 属性:"As" / "Td" 等(rank ∈ 2-9TJQKA,suit ∈ s/h/d/c);空串或 "back" 显示牌背。
Component({
  options: { addGlobalClass: true },
  properties: {
    card: { type: String, value: '' },
    size: { type: String, value: 'md' } // sm | md | lg
  },
  data: {
    faceUp: false,
    empty: true,
    rank: '',
    suitChar: '♠',
    red: false
  },
  observers: {
    card(v) {
      const m = /^([2-9TJQKA])([shdc])$/.exec(v || '')
      if (!m) {
        // '' = 空位(虚线框);"back" = 牌背
        this.setData({ faceUp: false, empty: v !== 'back' })
        return
      }
      const isRed = m[2] === 'h' || m[2] === 'd'
      const suitMap = { s: '♠', h: '♥', d: '♦', c: '♣' }
      this.setData({ faceUp: true, empty: false, rank: m[1], suitChar: suitMap[m[2]], red: isRed })
    }
  }
})
