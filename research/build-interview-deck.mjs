import fs from 'node:fs/promises';
import { Presentation, PresentationFile } from '@oai/artifact-tool';
import { buildSlide26 } from './templates/slide-26.mjs';
import { buildSlide11 } from './templates/slide-11.mjs';
import { buildSlide19 } from './templates/slide-19.mjs';

const OUT = 'C:/Users/duyuf/Documents/牡丹亭/《牡丹亭·惊梦》高中生访谈引导.pptx';
const BG = '#F7F1E7';

const p = Presentation.create({ slideSize: { width: 1280, height: 720 } });

function finish(slide, notes, source = '本项目访谈测试包与已校核《牡丹亭》原文') {
  slide.background.fill = BG;
  slide.speakerNotes.textFrame.setText(`${notes}\n\n[Sources]\n- ${source}`);
  return slide;
}

function sparse(kicker, main, sub, notes) {
  const slide = buildSlide26(p, {
    title: kicker,
    title2: main,
    title3: {
      loremIpsumDetails: sub,
      loremIpsumDetails2: '',
      loremIpsumDetails3: '',
    },
  });
  return finish(slide, notes);
}

function paired(title, lead, leftTitle, leftBody, rightTitle, rightBody, notes) {
  const slide = buildSlide11(p, {
    title,
    footer1: '',
    body1: {
      topic: lead,
      loremIpsumDolorSitAmetConsecteturAdipiscing: '',
      loremIpsumDolorSitAmetConsecteturAdipiscing2: '',
    },
    body2: leftTitle,
    body3: rightTitle,
    body4: {
      detailGoesHere: leftBody,
      detailGoesHere2: '',
      detailGoesHere3: '',
    },
    body5: {
      detailGoesHere: rightBody,
      detailGoesHere2: '',
      detailGoesHere3: '',
    },
  });
  return finish(slide, notes);
}

function three(title, lead, a, b, c, notes) {
  const slide = buildSlide19(p, {
    title,
    footer1: '',
    body1: { topic: lead, loremIpsumDolorSitAmetConsecteturAdipiscing: '' },
    stat1: '①', stat2: '②', stat3: '③',
    body2: a, body3: b, body4: c,
  });
  return finish(slide, notes);
}

sparse(
  '牡丹亭 · 惊梦',
  '陪我们试读一次',
  '高中生互动阅读体验',
  '开场保持轻松。不要先介绍“觉醒”“反抗礼教”“不可逆”等创作主题。'
);

sparse(
  '开始以前',
  '今天不是考试',
  '没有标准答案，也不用提前复习',
  '照读：今天主要是测试作品，不是测试你。看不懂、觉得无聊、不知道点哪里，都对我们有帮助。'
);

sparse(
  '先看两句',
  '原来姹紫嫣红开遍，\n似这般都付与断井颓垣。',
  '良辰美景奈何天，赏心乐事谁家院！',
  '先安静展示，不解释词义。让学生自行阅读。若他询问生词，可先问“你现在会怎么猜？”，记录后再解释。',
  '《牡丹亭》第十出《惊梦》项目校核原文'
);

sparse(
  '不用标准答案',
  '你觉得这里\n主要写了什么？',
  '不确定，也可以说出现在最自然的猜测',
  '记录学生原话。追问：是什么词让你这样想？不要说“是不是只在写景”。'
);

paired(
  '接下来，你会自己走进《惊梦》',
  '请像平时第一次打开一个网页那样体验。',
  '你可以',
  '停下来、返回、改主意，也可以说“不知道”。',
  '我们会',
  '观察哪里难懂；不会评价你的文学答案。',
  '把设备交给学生。只说：遇到困惑时，如果方便，可以把脑子里的想法说出来。'
);

sparse(
  '体验任务',
  '读到哪里时，\n你开始觉得她不一样了？',
  '先留下一句；读到后面，也可以改变判断',
  '不要解释针脚的文学意义。如果界面无法让学生知道怎么操作，记录为产品问题。'
);

sparse(
  '现在，请打开体验网页',
  '按自己的节奏读',
  '需要帮助时，随时告诉我',
  '开始计时。主持人保持安静。卡住约10秒后先问：“你现在期待这里发生什么？”只提供最低限度帮助。'
);

sparse(
  '体验结束',
  '先离开网页想一想',
  '下面没有正确答案',
  '请学生暂时不要回看页面，先用自己的话回答，以免照抄结尾文案。'
);

sparse(
  '再看一次',
  '现在你会怎样解释\n“姹紫嫣红”？',
  '和刚开始相比，没变也可以',
  '记录完整原话。若学生只重复系统文案，追问：“如果不用网页里的说法，你会怎么讲给同学听？”'
);

paired(
  '你的判断落在了哪里？',
  '请回到原文，指出具体句子。',
  '变化从哪里开始？',
  '为什么是这一句，而不是更前或更后？',
  '哪句支持你？',
  '请用原文说明，不必使用文学术语。',
  '重点观察是否能主动找到证据，不判断针脚位置对错。坚持原选择并能回应其他证据同样有效。'
);

three(
  '后来出现的那句原文，和你的判断是什么关系？',
  '先听你的理解，再看系统解释。',
  '支持了我',
  '让我改主意',
  '让问题更复杂',
  '先让学生自由回答，再用三个方向帮助表达；不要强迫三选一。继续追问：为什么系统会在这里给你看这句话？'
);

paired(
  '作品哪里最需要改？',
  '真实感受比“挺好的”更有帮助。',
  '最想跳过的地方',
  '是因为看不懂、太慢，还是不知道为什么要做？',
  '最记得的时刻',
  '请说发生了什么，不必只评价画面。',
  '学生批评时不要解释或辩护。追问具体场景：“如果删掉它，会有什么不同？”'
);

sparse(
  '最后一个问题',
  '如果发给同学，\n你会怎么介绍它？',
  '你会想继续读《寻梦》吗？为什么？',
  '这两个问题分别检验作品是否可复述，以及是否真的形成继续阅读的动力。记录原话。'
);

sparse(
  '谢谢你',
  '你的困惑，也在帮助作品生长',
  '没有一个回答会被记成对错',
  '说明匿名和后续用途。询问是否愿意在改版后再次体验，但不要施压。'
);

paired(
  '访谈结束后 · 主持人复盘',
  '这一页不要向学生展示。先记录，再讨论修改。',
  '理解有没有变化？',
  '是出现新证据，还是只复述了系统提示？',
  'Agent有没有价值？',
  '学生能否说清回应为何与自己的选择有关？',
  '立即填写单场记录表。除阻断性故障外，至少完成三场后再统一修改产品。'
);

for (const [i, slide] of p.slides.items.entries()) {
  const items = slide.elements?.items || [];
  for (const el of items) {
    if (el.text?.style) el.text.style.typeface = 'Microsoft YaHei';
  }
}

const pptx = await PresentationFile.exportPptx(p);
await pptx.save(OUT);
await fs.writeFile('C:/Users/duyuf/Documents/牡丹亭/.tmp/interview-deck/source-notes.txt',
  'Visible copy and presenter notes are adapted from the local research kit. Literary quotations are from the project\'s checked chapter10.json.\n', 'utf8');

console.log(OUT);
