/**
 * 翻阅式 AI 阅读《牡丹亭·惊梦》两回五页
 *   每页 = 引言 + 3-4 句诗句 + 今译 + 点拨
 *   划过即读过，停留 AI 回应，翻页 AI 观察。
 *   场景字段 scene 驱动背景切换（起/承/转/合）：春朝 → 庭园 → 暮色 → 入梦 → 梦醒
 */

import { assetUrl } from './assetBase'

export interface BookPage {
  id: string
  kind?: 'chapter' | 'content'  // chapter = 回目页（引子）；content = 一页一句
  chapter: string        // 第一回 / 第二回
  chapterTitle: string   // 游园 / 惊梦
  qupai?: string         // 昆曲曲牌名（唱词依曲牌而填）：游园〔皂罗袍〕〔好姐姐〕，惊梦〔山桃红〕
  act: string            // 幕名（初见春色 / 看见自己 / 惜春 / 入梦 / 梦醒）——剧情锚点
  stageNote: string      // 场记·时间地点（午后·杜府后园 / 夜·梦中 …）
  stageLine: string      // 场记·一句剧情（她第一次真正看见春天。）
  scene: 'spring' | 'garden' | 'dusk' | 'dream' | 'wake'  // 纸面色温（起承转合）
  dream?: boolean        // 惊梦页：梦里柳生以原文应你所停之字
  image?: string         // 剧情高潮处才浮现的场景画（平时是干净纸面，不凑数）
  imageOnGrant?: boolean // 点字带走（这一页她把门）之后，画面才浮现这张场景画
  epigraph?: string      // 页首引言（白话背景，进入情境）
  lines: string[]        // 一页 3-4 句
  vernacularLines: string[] // 逐句今译（与 lines 一一对应）
  vernacular: string     // 今译
  note?: string          // 读这一句要知道（文言点拨）；惊梦页（p4）无此留白，对话浮层代之
}

export const BOOK: BookPage[] = [
  {
    id: 'p1',
    kind: 'content',
    chapter: '第一回',
    chapterTitle: '游园',
    qupai: '皂罗袍',
    act: '初见春色',
    stageNote: '午后 · 杜府后园',
    stageLine: '她第一次真正看见春天。',
    scene: 'spring',
    // 点一个字替她带走后，满园春色才成画——游园场景图浮现
    image: assetUrl('mudanting-scene-garden.webp'),
    imageOnGrant: true,
    lines: ['原来姹紫嫣红开遍', '似这般都付与断井颓垣', '良辰美景奈何天', '赏心乐事谁家院'],
    vernacularLines: [
      '原来繁盛的花，开满了整个园子',
      '却都开在残墙断井边，白白付与了荒凉',
      '这样的好时辰好景致，偏偏天不作美',
      '叫人赏心的乐事，又落在谁家的院子里',
    ],
    vernacular: '原来繁盛的花开满了园子，却都开在残墙破井边。这样的好时光好景致，偏偏天不作美；赏心的乐事，又在谁家的院子里？',
    note: '她头一回看见园子，才知道"姹紫嫣红"不是书里的词，是真的花开满园。读尽这一页，她才许你随她往园子深处去。',
  },
  {
    id: 'p2',
    kind: 'content',
    chapter: '第一回',
    chapterTitle: '游园',
    qupai: '皂罗袍',
    act: '看见自己',
    stageNote: '日色渐深',
    stageLine: '她忽然发现，「锦屏人」说的正是自己。',
    scene: 'garden',
    // 她送你一个字（锦屏人），你收下后，正午庭园画面浮现
    image: '/assets/mudanting-scene-noon.webp',
    imageOnGrant: true,
    lines: ['朝飞暮卷，云霞翠轩', '雨丝风片，烟波画船', '锦屏人忒看的这韶光贱'],
    vernacularLines: [
      '朝云暮霞，卷过翠色的轩窗',
      '细雨微风，烟波里停着画船',
      '我这被锦屏关住的人，把春光看得太贱了',
    ],
    vernacular: '朝云暮卷，云霞映着翠轩；细雨微风，烟波里停着画船。我这个被锦屏关着的人，把这么好的时光看贱了。',
    note: '这园子，她从早看到晚、从晴看到雨。"锦屏人"——被屏风挡住的人，原是她自己。读尽这一页，她会应允你往下一幕去。',
  },
  {
    id: 'p3',
    kind: 'content',
    chapter: '第一回',
    chapterTitle: '游园',
    qupai: '好姐姐',
    act: '惜春',
    stageNote: '暮色将合',
    stageLine: '春色越盛，她越意识到它终究会过去。',
    scene: 'dusk',
    // 你按住牡丹留住春后，暮色画面浮现
    image: '/assets/mudanting-scene-dusk.webp',
    imageOnGrant: true,
    lines: ['遍青山啼红了杜鹃', '荼蘼外烟丝醉软', '牡丹虽好，他春归怎占的先', '闲凝眄，生生燕语明如翦'],
    vernacularLines: [
      '青山开遍杜鹃，像是被春啼红的',
      '荼蘼架外，柳丝在烟里醉软地垂着',
      '牡丹虽好，可春一归去，它也占不得先',
      '我凝神看时，只听见燕语生生，明快如剪',
    ],
    vernacular: '青山开遍了杜鹃，像是被春啼红的；荼蘼架外烟丝醉软。牡丹虽好，春天一归它却占不得先。我凝神听去，燕语生生，明如剪、滑如珠。',
    note: '春要尽了：杜鹃啼红，燕语如剪。她看花的眼，从惊喜转成了惜春。读尽这一页，她带你入梦。',
  },
  {
    id: 'p4',
    kind: 'content',
    chapter: '第二回',
    chapterTitle: '惊梦',
    qupai: '山桃红',
    act: '入梦',
    stageNote: '夜 · 梦中',
    stageLine: '她睡去了。一个素未谋面的书生走进她的梦。',
    scene: 'dream',
    dream: true,
    // 全篇唯一一张场景画：入梦那一刻，满园春色变成有图可看的梦
    image: '/assets/mudanting-scene-dream.webp',
    lines: ['则为你如花美眷', '似水流年', '是答儿闲寻遍', '在幽闺自怜'],
    vernacularLines: [
      '只因为你这样的如花美人',
      '才更衬得年华如水般流走',
      '到处都寻遍了',
      '只剩在深闺里，自己怜惜自己',
    ],
    vernacular: '他叹：只因为你这样的如花美人，才更衬得年华似水。梦醒后到处寻遍，寻不见；只剩深闺里，自己怜惜自己。',
  },
  {
    id: 'p5',
    kind: 'content',
    chapter: '第二回',
    chapterTitle: '惊梦',
    qupai: '山桃红',
    act: '梦醒',
    stageNote: '天将明',
    stageLine: '梦散了，可有些东西已经无法跟着梦一起消失。',
    scene: 'wake',
    dream: true,
    // 点一个字作纪念带走后，梦醒画面浮现
    image: assetUrl('mudanting-scene-wake.webp'),
    imageOnGrant: true,
    lines: ['睡荼蘼抓住裙衩线', '恰便是花似人心向好处牵', '早难道好处相逢无一言'],
    vernacularLines: [
      '梦里，荼蘼的藤蔓勾住了我的裙边',
      '就像花也懂人心，向着好处相牵',
      '难道这样好的相逢，竟连一句话也没留下，就醒了吗',
    ],
    vernacular: '梦里荼蘼抓住裙边，像是花也懂人心、向好处牵。可梦一醒，那样好的相逢，竟连一言也没留下。',
    note: '梦将醒时，花枝勾住她的裙边，像在挽留。读尽这一页，她这一路的话，也就说完了。',
  },
]

/**
 * 她把门：每一幕的过关方式都不同（起承转合，幕幕别样）——
 *   pick     默认：在这一页的原文里点一个字给她（她心里的字应得更深，其他字她也接住）
 *   tradeoff 取舍：满园颜色她只带得走一个，你替她带走（另一个留在园里，结尾回响）
 *   gift     受赠：这次反过来，她送你一个字，你收下（相识簿标「她送你的」）
 *   hold     挽留：按住将谢的牡丹，替她留住春（长按）
 *   dwell    停留即缘：梦里不点字，你停住的字柳生都接住，停满 N 个不同字，梦便成了
 *   keep     纪念：点一个字带走，随即收束成曲
 */
export interface TradeoffSide {
  label: string    // 这一边的名字（春色 / 残色）
  phrase: string   // 整句（姹紫嫣红 / 断井颓垣），供结尾回响
  chars: string[]  // 这一边的字
  reply: string    // 选这一边时她的回应
}
export interface GateTask {
  ask: string
  hint: string
  mode?: 'pick' | 'tradeoff' | 'gift' | 'hold' | 'dwell' | 'keep'
  target?: string[]       // pick / gift / hold：她心里的字；空数组 = 任何字皆可
  holdMs?: number         // hold：按住多久
  dwellNeed?: number      // dwell：梦里需停满的不同字数
  tradeoff?: { keep: TradeoffSide; letGo: TradeoffSide; neither: string }
  replyTarget?: string    // 命中时的回应（gift 用 X 占位，替换为所收的字）
  replyOther?: string     // 其他回应（温和，不惩罚）
}
export const GATE_TASKS: Record<string, GateTask> = {
  // 起·春朝：取舍——她只带得走一个字
  p1: {
    ask: '我头一回看见园子，满眼都是颜色，心口先慌了一下。姹紫嫣红，断井颓垣——我这一趟，只带得走一个字。你替我从园子里带走一个，另一个，就留在这里。',
    hint: '在「姹紫嫣红」或「断井颓垣」里点一个字，替她带走',
    mode: 'tradeoff',
    tradeoff: {
      keep: {
        label: '春色',
        phrase: '姹紫嫣红',
        chars: ['姹', '紫', '嫣', '红'],
        reply: '（她望着你点的字，微微点头）你把春色带进梦里来了。姹紫嫣红——我记着你替我带走的这个字。',
      },
      letGo: {
        label: '残色',
        phrase: '断井颓垣',
        chars: ['断', '井', '颓', '垣'],
        reply: '（她顺着你点的字看去，轻声）你替我带走了断井颓垣。花开得再好，也躲不过这一处残败——我记着你替我带走的这个字。',
      },
      neither: '这个字我也舍不得，可这一趟我只带得走一个。你替我从姹紫嫣红与断井颓垣里，挑一个字罢。',
    },
  },
  // 承·庭园：受赠——她送你一个字
  p2: {
    ask: '看了一日园子，我最舍不下的，是几个字——那被锦屏关着的人。我把其中一个送给你，你带着它往下走。',
    hint: '在「锦屏人」三个字里点一个字，收下她送你的字',
    mode: 'gift',
    target: ['锦', '屏', '人'],
    replyTarget: '我把「X」送给你了。被屏风关着的人，是我——现在，也是你。',
    replyOther: '你要这个字，我便送你。只是我心里最重的，还是那被锦屏关着的人。',
  },
  // 转·暮色：挽留——按住将谢的牡丹
  p3: {
    ask: '春要尽了。牡丹虽好，他春归怎占的先——你替我按住那朵牡丹，多留它一刻。',
    hint: '按住「牡丹」二字，替她留住将谢的春',
    mode: 'hold',
    target: ['牡', '丹'],
    holdMs: 1600,
    replyTarget: '你替她按住了一刻。春还是要走的，可有人这样留过它，便不算白开。',
    replyOther: '不是这朵。你替我按住那占不得先的牡丹——按住它，别放手。',
  },
  // 转·入梦：停留即缘——梦里的字，柳生都接住（一次深停，梦便成了）
  p4: {
    ask: '梦里，你停住的字，他都接得住。停一处，这一梦便成了。',
    hint: '在梦里停一个字，柳生会接住你',
    mode: 'dwell',
    dwellNeed: 1,
    replyTarget: '梦成了。你停过的字，他都听见了。',
    replyOther: '再停一处，梦便成了。',
  },
  // 合·梦醒：纪念——点一个字带走，随即收束
  p5: {
    ask: '这一路，你都陪我读完了。临了，你在这页里点一个字，当作你带走的纪念罢。',
    hint: '点一个字带走',
    mode: 'keep',
    target: [],
    replyTarget: '你带走的这个字，我记下了。梦会醒，园会谢——但有人记得读过，便不算空。',
    replyOther: '你带走的这个字，我记下了。梦会醒，园会谢——但有人记得读过，便不算空。',
  },
}

/**
 * 曲牌句位：某页某行在整个曲牌里的第几句（跨页累计），如「〔皂罗袍〕第三句」。
 * 昆曲的板眼：句有句位，板有板眼——她唱到第几句，读者一望便知。
 */
export function qupaiLabelOf(pageId: string, lineIdx: number): string {
  const target = BOOK.find(p => p.id === pageId)
  if (!target || !target.qupai) return ''
  let n = 0
  for (const p of BOOK) {
    if (p.id === pageId) { n += lineIdx + 1; break }
    if (p.qupai && p.qupai === target.qupai) n += p.lines.length
  }
  return `〔${target.qupai}〕第${n}句`
}