/**
 * 8言語の台本を作る。
 *
 *   node scripts/test-agent/make-scenarios.mjs
 *
 * ★台本の作り
 *   01 きっぷの買い方      … 実務の流れ（4往復）
 *   02 乗り換えの案内      … 実務の流れ（4往復）※馬喰横山=登録あり／神保町=登録なし
 *   03 駅名の聞き取り比べ   … 同じ文型で駅名だけ入れ替え（8往復）
 *
 * ★03 の駅名は「用語集に登録がある4駅」と「ない4駅」を交互に置く。
 *   登録あり駅は用語集の訳語をそのまま言わせる（その言語の欄の値）。
 *   登録なし駅は、その言語で自然な書き方にする。
 *
 * ★韓国語・タイ語について
 *   用語集の ko / th 欄はローマ字（Nippori 等）で登録されている。しかし実際の
 *   お客様は「닛포리」「นิปโปริ」と自国の文字で話す。ここではあえて自国の文字で
 *   言わせ、**ローマ字登録のままで訳語固定が効くのかどうか**を実測する。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 03で使う8駅。inGlossary=用語集に登録があるか。 */
const STATIONS = [
  { ja: "日暮里", inGlossary: true },
  { ja: "曙橋", inGlossary: false },
  { ja: "馬喰横山", inGlossary: true },
  { ja: "岩本町", inGlossary: false },
  { ja: "用賀", inGlossary: true },
  { ja: "小川町", inGlossary: false },
  { ja: "碑文谷", inGlossary: true },
  { ja: "浜町", inGlossary: false },
];

/** 各言語での駅名の書き方（登録ありは用語集の値、なしは自然な表記）。 */
const NAMES = {
  ja: ["日暮里", "曙橋", "馬喰横山", "岩本町", "用賀", "小川町", "碑文谷", "浜町"],
  en: ["Nippori", "Akebonobashi", "Bakuro-Yokoyama", "Iwamotocho", "Yoga", "Ogawamachi", "Himonya", "Hamacho"],
  zh: ["日暮里", "曙桥", "马喰横山", "岩本町", "用贺", "小川町", "碑文谷", "浜町"],
  "zh-TW": ["日暮里", "曙橋", "馬喰橫山", "岩本町", "用賀", "小川町", "碑文谷", "濱町"],
  ko: ["닛포리", "아케보노바시", "바쿠로요코야마", "이와모토초", "요가", "오가와마치", "히몬야", "하마초"],
  fr: ["Nippori", "Akebonobashi", "Bakuro-Yokoyama", "Iwamotocho", "Yoga", "Ogawamachi", "Himonya", "Hamacho"],
  es: ["Nippori", "Akebonobashi", "Bakuro-Yokoyama", "Iwamotocho", "Yoga", "Ogawamachi", "Himonya", "Hamacho"],
  th: ["นิปโปริ", "อาเคโบโนบาชิ", "บาคุโระโยโกยามะ", "อิวาโมโตโช", "โยกะ", "โอกาวามาจิ", "ฮิมงยะ", "ฮามาโช"],
};

/** 03の文型（A＝行き方、B＝出口）。{S} が駅名に置き換わる。 */
const PATTERNS = {
  ja: ["すみません、{S}までの行き方を教えてください。", "{S}で降りたいのですが、何番出口が近いですか。"],
  en: ["Excuse me, how do I get to {S}?", "I want to get off at {S}. Which exit is closest?"],
  zh: ["请问，到{S}怎么走？", "我想在{S}下车，哪个出口最近？"],
  "zh-TW": ["請問，到{S}要怎麼走？", "我想在{S}下車，哪個出口最近？"],
  ko: ["실례합니다. {S}까지 어떻게 가나요?", "{S}에서 내리고 싶은데요, 몇 번 출구가 가까운가요?"],
  fr: ["Excusez-moi, comment aller à {S} ?", "Je voudrais descendre à {S}. Quelle sortie est la plus proche ?"],
  es: ["Disculpe, ¿cómo llego a {S}?", "Quiero bajarme en {S}. ¿Qué salida está más cerca?"],
  th: ["ขอโทษครับ ไป{S}อย่างไรครับ", "ผมอยากลงที่{S} ทางออกไหนใกล้ที่สุดครับ"],
};

/** 01・02のお客様の台詞。順番は下の staffJa と対応する。 */
const LINES = {
  ja: {
    "01": ["すみません、日暮里までのきっぷはどうやって買えばいいですか。", "押しました。次はどうすればいいですか。",
      "現金でも払えますか。それともスイカだけですか。", "わかりました。ありがとうございます。"],
    "02": ["馬喰横山で乗り換えたいのですが、どのホームですか。", "そこから神保町までは何分くらいかかりますか。",
      "急行は止まりますか。", "助かりました。ありがとうございました。"],
  },
  en: {
    "01": ["Excuse me, how do I buy a ticket to Nippori?", "I pressed it. What should I do next?",
      "Can I pay with cash, or only with Suica?", "I see. Thank you very much."],
    "02": ["I want to transfer at Bakuro-Yokoyama. Which platform should I use?",
      "How many minutes does it take from there to Jimbocho?",
      "Does the express train stop here?", "That was very helpful. Thank you."],
  },
  zh: {
    "01": ["请问，到日暮里的车票怎么买？", "我按了。接下来该怎么做？",
      "可以用现金支付吗？还是只能用Suica？", "我明白了，谢谢。"],
    "02": ["我想在马喰横山换乘，请问在几号站台？", "从那里到神保町大概要几分钟？",
      "急行列车停这一站吗？", "帮了大忙，非常感谢。"],
  },
  "zh-TW": {
    "01": ["請問，到日暮里的車票要怎麼買？", "我按了。接下來該怎麼做？",
      "可以用現金付款嗎？還是只能用Suica？", "我明白了，謝謝。"],
    "02": ["我想在馬喰橫山換車，請問在幾號月台？", "從那裡到神保町大概要幾分鐘？",
      "急行列車有停這一站嗎？", "幫了大忙，非常感謝。"],
  },
  ko: {
    "01": ["실례합니다. 닛포리까지 가는 표는 어떻게 사나요?", "눌렀습니다. 다음은 어떻게 하면 되나요?",
      "현금으로도 낼 수 있나요? 아니면 스이카만 되나요?", "알겠습니다. 감사합니다."],
    "02": ["바쿠로요코야마에서 갈아타고 싶은데요, 몇 번 승강장인가요?", "거기서 진보초까지는 몇 분 정도 걸리나요?",
      "급행도 서나요?", "도움이 되었습니다. 감사합니다."],
  },
  fr: {
    "01": ["Excusez-moi, comment puis-je acheter un billet pour Nippori ?", "J'ai appuyé. Que dois-je faire ensuite ?",
      "Puis-je payer en espèces, ou seulement avec Suica ?", "Je comprends. Merci beaucoup."],
    "02": ["Je voudrais changer de train à Bakuro-Yokoyama. Quel quai dois-je prendre ?",
      "Combien de minutes faut-il de là jusqu'à Jimbocho ?",
      "Est-ce que l'express s'arrête ici ?", "Cela m'a beaucoup aidé. Merci."],
  },
  es: {
    "01": ["Disculpe, ¿cómo puedo comprar un billete para Nippori?", "Ya lo he pulsado. ¿Qué hago ahora?",
      "¿Puedo pagar en efectivo, o solo con Suica?", "Entiendo. Muchas gracias."],
    "02": ["Quiero hacer transbordo en Bakuro-Yokoyama. ¿En qué andén?",
      "¿Cuántos minutos se tarda desde allí hasta Jimbocho?",
      "¿El tren expreso para en esta estación?", "Me ha ayudado mucho. Gracias."],
  },
  th: {
    "01": ["ขอโทษครับ ซื้อตั๋วไปนิปโปริอย่างไรครับ", "กดแล้วครับ ต่อไปต้องทำอย่างไรครับ",
      "จ่ายเงินสดได้ไหมครับ หรือใช้ได้แค่ซุยกะ", "เข้าใจแล้วครับ ขอบคุณครับ"],
    "02": ["ผมอยากเปลี่ยนขบวนที่บาคุโระโยโกยามะ ชานชาลาที่เท่าไหร่ครับ",
      "จากตรงนั้นไปจิมโบโจใช้เวลากี่นาทีครับ",
      "รถด่วนจอดที่นี่ไหมครับ", "ช่วยได้มากเลยครับ ขอบคุณครับ"],
  },
};

/** お客様の台詞が「日本語で何を言っているつもりか」。逆翻訳の答え合わせに使う。 */
const INTENT = {
  "01": ["すみません、日暮里までのきっぷはどうやって買えばいいですか。", "押しました。次はどうすればいいですか。",
    "現金でも払えますか。それともスイカだけですか。", "わかりました。ありがとうございます。"],
  "02": ["馬喰横山で乗り換えたいのですが、どのホームですか。", "そこから神保町までは何分くらいかかりますか。",
    "急行は止まりますか。", "助かりました。ありがとうございました。"],
};

/** 係員の返事（全言語共通の日本語）。 */
const STAFF = {
  "01": ["はい、ご案内します。画面の左上にある「きっぷを買う」を押してください。",
    "運賃が表示されますので、日暮里の二百二十円を選んでください。",
    "どちらでも大丈夫です。現金の場合は右の投入口にお入れください。",
    "お気をつけて行ってらっしゃいませ。"],
  "02": ["馬喰横山では、地下二階の三番ホームにお進みください。",
    "神保町までは、およそ八分でございます。",
    "はい、急行も停車いたします。",
    "どういたしまして。お気をつけてお越しください。"],
  "03": ["はい、新宿線で馬喰横山まで行き、そこで乗り換えてください。",
    "はい、新宿線でそのまま三つ目の駅でございます。",
    "はい、この電車でそのまま行けます。所要時間は十分ほどです。",
    "はい、こちらも新宿線でそのまま行けます。四つ目の駅です。",
    "二番出口が最も近くなっております。",
    "こちらは三番出口が近くなっております。",
    "一番出口をご利用ください。",
    "浜町でしたら、四番出口が近くなっております。"],
};

/** 01・02の中に出てくる駅名の検査（登録あり／なしの両方を含めてある）。 */
const INLINE_CHECKS = {
  "01": [{ term: "日暮里", inGlossary: true }, null, null, null],
  "02": [{ term: "馬喰横山", inGlossary: true }, { term: "神保町", inGlossary: false }, null, null],
};

// ══════════════════════════════════════════════════════════════════════════
// 04 鉄道用語の聞き取り比べ
//
// 01〜03では用語集31語のうち4語しか出てこない。この試験の成果物は
// 「誤認識された語の一覧」なので、出てくる語が少なければ見つかる問題も少ない。
// 残り25語をここで一通り言わせる。
//
// ★語の書き方は用語集から自動で取る。欄が空の言語は下の FALLBACK を使い、
//   「用語集なし」として数える。英語・フランス語・スペイン語は鉄道用語の欄が
//   空のままなので、そのこと自体の影響がここで測れる。
// ══════════════════════════════════════════════════════════════════════════

/** 各往復で使う用語（用語集の日本語欄の値）。 */
const T04 = [
  ["乗り越し精算", "精算機"],
  ["切符", "精算"],
  ["PASMO", "チャージ", "残高"],
  ["領収書", "運賃"],
  ["改札口", "エレベーター"],
  ["各駅停車", "特急"],
  ["新宿線", "南北線", "乗り換え", "ホーム"],
  ["舎人ライナー", "舎人", "電車"],
  ["麻布十番", "構内図", "狸穴町"],
  ["振替輸送", "構内地図"],
];

/** 用語集の欄が空のときに使う、その言語で自然な言い方。 */
const FALLBACK = {
  ja: {},
  en: { 切符: "ticket", チャージ: "top up", 残高: "balance", 領収書: "receipt", 運賃: "fare",
    改札口: "ticket gate", エレベーター: "elevator", 各駅停車: "local train", 特急: "limited express",
    乗り換え: "transfer", ホーム: "platform", 電車: "train", 構内図: "station layout map" },
  fr: { 切符: "billet", チャージ: "recharge", 残高: "solde", 領収書: "reçu", 運賃: "tarif",
    改札口: "portillon", エレベーター: "ascenseur", 各駅停車: "train omnibus", 特急: "train express",
    乗り換え: "correspondance", ホーム: "quai", 電車: "train", 構内図: "plan de la gare",
    乗り越し精算: "régularisation de titre", 精算: "régularisation", 精算機: "borne de régularisation",
    振替輸送: "transport de remplacement", 構内地図: "plan de la gare" },
  es: { 切符: "billete", チャージ: "recarga", 残高: "saldo", 領収書: "recibo", 運賃: "tarifa",
    改札口: "puerta de acceso", エレベーター: "ascensor", 各駅停車: "tren local", 特急: "tren expreso",
    乗り換え: "transbordo", ホーム: "andén", 電車: "tren", 構内図: "plano de la estación",
    乗り越し精算: "pago del suplemento", 精算: "ajuste de tarifa", 精算機: "máquina de ajuste",
    振替輸送: "transporte alternativo", 構内地図: "plano de la estación" },
  zh: { 構内図: "站内平面图" },
  "zh-TW": { 構内図: "站內平面圖" },
  ko: {},
  th: {},
};

/** 04の文型。{1}〜{4} が上の用語に置き換わる。 */
const P04 = {
  ja: ["{1}をしたいのですが、{2}はどこにありますか。", "{1}をなくしてしまいました。{2}はどうすればいいですか。",
    "{1}に{2}したいのですが、{3}はどこで見られますか。", "{1}がほしいのですが、{2}はいくらでしたか。",
    "{1}はどちらですか。{2}も使えますか。", "{1}と{2}では、どちらが早く着きますか。",
    "{1}から{2}への{3}は、どの{4}ですか。", "{1}で{2}まで行きたいのですが、{3}は何分おきですか。",
    "{1}の{2}はありますか。{3}にも行きたいです。", "事故のときは{1}がありますか。{2}もいただけますか。"],
  en: ["I need to do a {1}. Where is the {2}?", "I lost my {1}. What should I do about the {2}?",
    "I want to {2} my {1} card. Where can I check the {3}?", "I would like a {1}. How much was the {2}?",
    "Where is the {1}? Can I use the {2} as well?", "Which is faster, the {1} or the {2}?",
    "For the {3} from the {1} to the {2}, which {4} should I use?",
    "I want to go to {2} on the {1}. How often does the {3} run?",
    "Do you have a {2} of {1}? I also want to go to {3}.",
    "Is there {1} when there is an accident? Could I also have a {2}?"],
  zh: ["我想{1}，请问{2}在哪里？", "我把{1}弄丢了，{2}该怎么办？",
    "我想给{1}{2}，请问在哪里可以看到{3}？", "我想要{1}，请问{2}是多少？",
    "请问{1}在哪边？也可以用{2}吗？", "{1}和{2}，哪个到得更快？",
    "从{1}到{2}的{3}，要在哪个{4}？", "我想坐{1}去{2}，请问{3}多久一班？",
    "有{1}的{2}吗？我还想去{3}。", "发生事故的时候有{1}吗？也可以给我{2}吗？"],
  "zh-TW": ["我想{1}，請問{2}在哪裡？", "我把{1}弄丟了，{2}該怎麼辦？",
    "我想幫{1}{2}，請問在哪裡可以看到{3}？", "我想要{1}，請問{2}是多少？",
    "請問{1}在哪邊？也可以用{2}嗎？", "{1}和{2}，哪個到得更快？",
    "從{1}到{2}的{3}，要在哪個{4}？", "我想坐{1}去{2}，請問{3}多久一班？",
    "有{1}的{2}嗎？我還想去{3}。", "發生事故的時候有{1}嗎？也可以給我{2}嗎？"],
  ko: ["{1}을 하고 싶은데요, {2}은 어디에 있나요?", "{1}을 잃어버렸습니다. {2}은 어떻게 하면 되나요?",
    "{1}에 {2}하고 싶은데요, {3}은 어디에서 볼 수 있나요?", "{1}을 받고 싶은데요, {2}은 얼마였나요?",
    "{1}은 어느 쪽인가요? {2}도 사용할 수 있나요?", "{1}과 {2} 중에 어느 쪽이 더 빨리 도착하나요?",
    "{1}에서 {2}으로 {3}하려면 어느 {4}인가요?", "{1}으로 {2}까지 가고 싶은데요, {3}은 몇 분 간격인가요?",
    "{1}의 {2}가 있나요? {3}에도 가고 싶습니다.", "사고가 났을 때 {1}이 있나요? {2}도 받을 수 있나요?"],
  fr: ["Je dois faire un {1}. Où se trouve le {2} ?", "J'ai perdu mon {1}. Que dois-je faire pour le {2} ?",
    "Je veux faire une {2} sur ma carte {1}. Où puis-je voir le {3} ?",
    "Je voudrais un {1}. Combien était le {2} ?", "Où est le {1} ? Puis-je aussi utiliser l'{2} ?",
    "Lequel est plus rapide, le {1} ou le {2} ?",
    "Pour la {3} de la {1} à la {2}, quel {4} dois-je prendre ?",
    "Je veux aller à {2} par le {1}. Tous les combien passe le {3} ?",
    "Avez-vous un {2} d'{1} ? Je veux aussi aller à {3}.",
    "Y a-t-il un {1} en cas d'accident ? Puis-je aussi avoir un {2} ?"],
  es: ["Necesito hacer un {1}. ¿Dónde está la {2}?", "He perdido mi {1}. ¿Qué hago para el {2}?",
    "Quiero hacer una {2} en mi tarjeta {1}. ¿Dónde puedo ver el {3}?",
    "Quisiera un {1}. ¿Cuánto era la {2}?", "¿Dónde está la {1}? ¿Puedo usar también el {2}?",
    "¿Cuál es más rápido, el {1} o el {2}?",
    "Para el {3} de la {1} a la {2}, ¿qué {4} debo tomar?",
    "Quiero ir a {2} en el {1}. ¿Cada cuántos minutos pasa el {3}?",
    "¿Tienen un {2} de {1}? También quiero ir a {3}.",
    "¿Hay {1} cuando hay un accidente? ¿Me puede dar también un {2}?"],
  th: ["ผมอยาก{1}ครับ {2}อยู่ที่ไหนครับ", "ผมทำ{1}หายครับ {2}ต้องทำอย่างไรครับ",
    "ผมอยาก{2}ใน{1}ครับ ดู{3}ได้ที่ไหนครับ", "ผมขอ{1}ครับ {2}เท่าไหร่ครับ",
    "{1}อยู่ทางไหนครับ ใช้{2}ได้ไหมครับ", "{1}กับ{2} อันไหนถึงเร็วกว่าครับ",
    "{3}จาก{1}ไป{2} ต้องไป{4}ไหนครับ", "ผมอยากไป{2}ด้วย{1}ครับ {3}มาทุกกี่นาทีครับ",
    "มี{2}ของ{1}ไหมครับ ผมอยากไป{3}ด้วยครับ", "เวลาเกิดอุบัติเหตุมี{1}ไหมครับ ขอ{2}ด้วยได้ไหมครับ"],
};

const STAFF04 = [
  "精算機は改札の手前、左側にございます。",
  "切符をなくされた場合は、精算所で再度お支払いいただきます。",
  "チャージは券売機でできます。残高は画面の右上に表示されます。",
  "領収書は精算機から出せます。運賃は二百二十円でした。",
  "改札口は突き当たりを右です。エレベーターもご利用いただけます。",
  "特急のほうが五分早く着きます。",
  "新宿線から南北線へは、地下三階の二番ホームです。",
  "舎人ライナーは五分おきに出ております。",
  "麻布十番の構内図はこちらでお渡しできます。狸穴町へは徒歩十分です。",
  "事故の際は振替輸送をご利用いただけます。構内地図もお渡しします。",
];

// ══════════════════════════════════════════════════════════════════════════
// 06 長い案内（先行再生の確認）
//
// 01〜04の係員の返事はどれも短く、1つの音声に収まってしまう。そのため
// 「文の区切りごとに先行して読み上げを始める」仕組み（v1.43.0）の出番が無く、
// 1回目のテストでは効果を測れなかった（T6＝最初の音声→最後の音声 が0秒）。
// ここでは長い案内をわざと返させ、分割再生が働くかと、その効果を測る。
// ══════════════════════════════════════════════════════════════════════════

const P06 = {
  ja: ["駅の構内で迷ってしまいました。改札からホームまでの行き方を詳しく教えてください。",
    "ありがとうございます。もう一度、順番に教えていただけますか。"],
  en: ["I am lost inside the station. Could you tell me in detail how to get from the ticket gate to the platform?",
    "Thank you. Could you tell me the order one more time?"],
  zh: ["我在车站里迷路了。请详细告诉我从检票口到站台怎么走。", "谢谢。可以请您再按顺序说一次吗？"],
  "zh-TW": ["我在車站裡迷路了。請詳細告訴我從檢票口到月台怎麼走。", "謝謝。可以請您再按順序說一次嗎？"],
  ko: ["역 안에서 길을 잃었습니다. 개찰구에서 승강장까지 가는 길을 자세히 알려 주세요.",
    "감사합니다. 한 번 더 순서대로 알려 주시겠어요?"],
  fr: ["Je me suis perdu dans la gare. Pouvez-vous m'expliquer en détail comment aller du portillon au quai ?",
    "Merci. Pouvez-vous me redire l'ordre encore une fois ?"],
  es: ["Me he perdido dentro de la estación. ¿Puede explicarme en detalle cómo ir desde la puerta de acceso al andén?",
    "Gracias. ¿Puede decirme el orden una vez más?"],
  th: ["ผมหลงทางในสถานีครับ ช่วยบอกทางจากประตูตรวจตั๋วไปชานชาลาอย่างละเอียดหน่อยครับ",
    "ขอบคุณครับ ช่วยบอกลำดับอีกครั้งได้ไหมครับ"],
};

/** ★わざと長くする。文の区切りが複数あることが大事（ここで分割再生が働く）。 */
const STAFF06 = [
  "承知しました。まず改札を出ずに、そのまま正面の通路をまっすぐお進みください。"
  + "突き当たりに案内板がございますので、そこを右に曲がってください。"
  + "少し進むとエスカレーターが二基ございます。左側が上り、右側が下りでございます。"
  + "左側の上りエスカレーターで二階へお上がりください。"
  + "上がりましたら、右手に三番ホームへの階段が見えてまいります。"
  + "そちらを降りていただくと、ホームに到着いたします。全部で五分ほどでございます。",
  "はい、順番に申し上げます。一つ目、正面の通路をまっすぐ進みます。"
  + "二つ目、突き当たりの案内板を右に曲がります。"
  + "三つ目、左側の上りエスカレーターで二階へ上がります。"
  + "四つ目、右手の階段を降りて三番ホームへ向かいます。"
  + "以上の四つでございます。ご不明な点がございましたら、いつでもお声がけください。",
];

async function main() {
  const glossary = JSON.parse(await readFile(path.join(HERE, "..", "..", "glossary", "terms.json"), "utf8"));
  /** その言語での言い方と、用語集に登録があるかを返す。 */
  const wordOf = (ja, lang) => {
    if (lang === "ja") return { word: ja, inGlossary: true };
    const e = glossary.find((t) => t.ja === ja);
    const v = (e?.[lang] ?? "").trim();
    if (v) return { word: v, inGlossary: true };
    const fb = FALLBACK[lang]?.[ja];
    if (!fb) throw new Error(`${lang} の「${ja}」の言い方がありません（FALLBACK に足してください）`);
    return { word: fb, inGlossary: false };
  };

  const dir = path.join(HERE, "scenarios");
  await mkdir(dir, { recursive: true });
  for (const lang of Object.keys(LINES)) {
    const names = NAMES[lang];
    const [patA, patB] = PATTERNS[lang];
    const scenarios = [
      {
        id: "01", title: "きっぷの買い方",
        turns: LINES[lang]["01"].map((userText, i) => ({
          userText, intentJa: INTENT["01"][i], staffJa: STAFF["01"][i],
          ...(INLINE_CHECKS["01"][i] ? { check: INLINE_CHECKS["01"][i] } : {}),
        })),
      },
      {
        id: "02", title: "乗り換えの案内",
        turns: LINES[lang]["02"].map((userText, i) => ({
          userText, intentJa: INTENT["02"][i], staffJa: STAFF["02"][i],
          ...(INLINE_CHECKS["02"][i] ? { check: INLINE_CHECKS["02"][i] } : {}),
        })),
      },
      {
        id: "03", title: "駅名の聞き取り比べ（用語集あり／なし）",
        note: "同じ文型で駅名だけを入れ替え、用語集に登録がある駅とない駅で結果を比べる。用語集は一切変更しない。",
        turns: STATIONS.map((st, i) => ({
          userText: (i < 4 ? patA : patB).replace("{S}", names[i]),
          intentJa: (PATTERNS.ja[i < 4 ? 0 : 1]).replace("{S}", st.ja),
          said: names[i],
          check: { term: st.ja, inGlossary: st.inGlossary },
          staffJa: STAFF["03"][i],
        })),
      },
      {
        id: "04", title: "鉄道用語の聞き取り比べ",
        note: "用語集の残り25語を一通り言わせる。欄が空の言語（英・仏・西の鉄道用語）は登録なしとして数え、その差も測る。",
        turns: T04.map((group, i) => {
          const ws = group.map((ja) => wordOf(ja, lang));
          let text = P04[lang][i];
          ws.forEach((w, n) => { text = text.replaceAll(`{${n + 1}}`, w.word); });
          let ja = P04.ja[i];
          group.forEach((g, n) => { ja = ja.replaceAll(`{${n + 1}}`, g); });
          return {
            userText: text, intentJa: ja, staffJa: STAFF04[i],
            checks: group.map((g, n) => ({ term: g, inGlossary: ws[n].inGlossary, said: ws[n].word })),
          };
        }),
      },
      {
        id: "06", title: "長い案内（先行再生の確認）",
        note: "係員がわざと長い案内を返す。文の区切りごとに先行して読み上げる仕組みが働くかと、その効果を測る。",
        turns: P06[lang].map((userText, i) => ({
          userText, intentJa: P06.ja[i], staffJa: STAFF06[i],
        })),
      },
      {
        id: "05", title: "耐久（5分連続・マイクを切らない）",
        note: "マイクを一度も切らずに5分以上話し続ける。約4.5分ごとの音声認識ストリーム張り替えをまたぐため、そこで言葉が落ちないかを見る。係員は相槌を打たない。",
        endurance: true,
        turns: [{
          // 01〜04の台詞を2周ぶんつなげて1回の長い発話にする（新しい翻訳は不要）
          parts: [...LINES[lang]["01"], ...LINES[lang]["02"],
            ...STATIONS.map((st, i) => (i < 4 ? patA : patB).replace("{S}", names[i])),
            ...T04.map((group, i) => {
              let t = P04[lang][i];
              group.forEach((g, n) => { t = t.replaceAll(`{${n + 1}}`, wordOf(g, lang).word); });
              return t;
            })],
          // 1周ぶんだけ持つ。何周させるかは音声を作るときに、実際の長さを測って決める
          // （言語によって読み上げの速さが違い、決め打ちだと足りない言語が出るため）。
          repeatToSeconds: 330,
          staffJa: null,   // 相槌を打たない
        }],
      },
    ];
    await writeFile(path.join(dir, `${lang}.json`), JSON.stringify(scenarios, null, 2) + "\n");
    const turns = scenarios.reduce((n, s) => n + s.turns.length, 0);
    console.log(`  ${lang.padEnd(6)} ${scenarios.length}シナリオ / ${turns}往復`);
  }
}

main().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
