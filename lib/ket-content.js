"use strict";

// Original short examples; vocabulary reference: Cambridge A2 Key, August 2025.
// Artwork: Twemoji 14.0.2, CC-BY 4.0. Stable IDs must not change when copy is edited.
const groups = [
  ["fruit", "水果篮", "#eaf6ed", [
    ["apple", "苹果", "I have a red apple.", "我有一个红苹果。", "1f34e"],
    ["banana", "香蕉", "This banana is yellow.", "这根香蕉是黄色的。", "1f34c"],
    ["orange", "橙子", "Can I have an orange?", "我可以吃一个橙子吗？", "1f34a"],
    ["pear", "梨", "The pear is sweet.", "这个梨很甜。", "1f350"],
    ["grape", "葡萄", "I like green grapes.", "我喜欢绿葡萄。", "1f347"],
    ["lemon", "柠檬", "Put a lemon in the bag.", "把一个柠檬放进袋子里。", "1f34b"],
    ["watermelon", "西瓜", "We share a watermelon.", "我们一起分享一个西瓜。", "1f349"],
    ["strawberry", "草莓", "This strawberry is small.", "这颗草莓很小。", "1f353"],
    ["tomato", "西红柿", "Cut the tomato, please.", "请切一下西红柿。", "1f345"],
    ["carrot", "胡萝卜", "The rabbit eats a carrot.", "兔子吃一根胡萝卜。", "1f955"]
  ]],
  ["animals", "动物朋友", "#e8f3fb", [
    ["cat", "猫", "My cat is on the bed.", "我的猫在床上。", "1f408"],
    ["dog", "狗", "The dog runs with me.", "这只狗和我一起跑。", "1f415"],
    ["rabbit", "兔子", "The rabbit has long ears.", "兔子的耳朵很长。", "1f407"],
    ["bird", "鸟", "A bird is in the tree.", "一只鸟在树上。", "1f426"],
    ["fish", "鱼", "Look at the blue fish.", "看那条蓝色的鱼。", "1f41f"],
    ["horse", "马", "The horse is very tall.", "这匹马很高。", "1f40e"],
    ["cow", "奶牛", "The cow eats grass.", "奶牛吃草。", "1f404"],
    ["sheep", "绵羊", "The sheep is white.", "这只绵羊是白色的。", "1f411"],
    ["duck", "鸭子", "The duck can swim.", "鸭子会游泳。", "1f986"],
    ["pig", "猪", "The pig is on the farm.", "这只猪在农场里。", "1f416"]
  ]],
  ["food", "美味餐桌", "#fff0e9", [
    ["bread", "面包", "I eat bread for breakfast.", "我早餐吃面包。", "1f35e"],
    ["egg", "鸡蛋", "There is an egg on my plate.", "我的盘子里有一个鸡蛋。", "1f95a"],
    ["cheese", "奶酪", "Would you like some cheese?", "你想吃些奶酪吗？", "1f9c0"],
    ["rice", "米饭", "We have rice for lunch.", "我们午餐吃米饭。", "1f35a"],
    ["cake", "蛋糕", "This cake is for you.", "这个蛋糕是给你的。", "1f370"],
    ["ice cream", "冰淇淋", "My ice cream is cold.", "我的冰淇淋是凉的。", "1f368"],
    ["pizza", "比萨饼", "Let's share a pizza.", "我们一起分享一个比萨饼吧。", "1f355"],
    ["sandwich", "三明治", "I made a cheese sandwich.", "我做了一个奶酪三明治。", "1f96a"],
    ["milk", "牛奶", "I drink milk every morning.", "我每天早晨喝牛奶。", "1f95b"],
    ["water", "水", "Please drink some water.", "请喝些水。", "1f4a7"]
  ]],
  ["school", "我的书包", "#eef0fc", [
    ["book", "书", "Open your book, please.", "请打开你的书。", "1f4d6"],
    ["pencil", "铅笔", "My pencil is yellow.", "我的铅笔是黄色的。", "270f"],
    ["pen", "钢笔", "Can I use your pen?", "我可以用你的钢笔吗？", "1f58a"],
    ["ruler", "尺子", "This ruler is long.", "这把尺子很长。", "1f4cf"],
    ["school bag", "书包", "My school bag is heavy.", "我的书包很重。", "1f392"],
    ["notebook", "笔记本", "Write it in your notebook.", "把它写在你的笔记本上。", "1f4d3"],
    ["scissors", "剪刀", "Use the scissors carefully.", "小心使用剪刀。", "2702"],
    ["computer", "电脑", "The computer is on the desk.", "电脑在书桌上。", "1f4bb"],
    ["clock", "钟", "Look at the clock.", "看看时钟。", "1f570"],
    ["school", "学校", "I walk to school.", "我步行去学校。", "1f3eb"]
  ]],
  ["home", "温暖的家", "#fcecf1", [
    ["house", "房子", "Our house has a red door.", "我们的房子有一扇红门。", "1f3e0"],
    ["door", "门", "Please close the door.", "请关上门。", "1f6aa"],
    ["window", "窗户", "Open the window, please.", "请打开窗户。", "1fa9f"],
    ["bed", "床", "It is time to go to bed.", "到上床睡觉的时间了。", "1f6cf"],
    ["chair", "椅子", "Sit on this chair.", "坐在这把椅子上。", "1fa91"],
    ["key", "钥匙", "Here is your key.", "这是你的钥匙。", "1f511"],
    ["telephone", "电话", "The telephone is ringing.", "电话正在响。", "260e"],
    ["mirror", "镜子", "I can see myself in the mirror.", "我能在镜子里看到自己。", "1fa9e"],
    ["bath", "浴缸", "The bath is full of water.", "浴缸里装满了水。", "1f6c1"],
    ["shower", "淋浴", "I have a shower after sport.", "运动后我洗淋浴。", "1f6bf"]
  ]],
  ["clothes", "出门穿什么", "#eaf6ed", [
    ["T-shirt", "T恤衫", "I wear a blue T-shirt.", "我穿一件蓝色T恤衫。", "1f455"],
    ["shirt", "衬衫", "His shirt is clean.", "他的衬衫很干净。", "1f454"],
    ["dress", "连衣裙", "She has a new dress.", "她有一条新连衣裙。", "1f457"],
    ["coat", "外套", "Put on your coat.", "穿上你的外套。", "1f9e5"],
    ["jeans", "牛仔裤", "These jeans are blue.", "这条牛仔裤是蓝色的。", "1f456"],
    ["shoe", "鞋", "There is a shoe under the bed.", "床下面有一只鞋。", "1f45e"],
    ["sock", "袜子", "I cannot find my other sock.", "我找不到另一只袜子了。", "1f9e6"],
    ["hat", "帽子", "This hat keeps me cool.", "这顶帽子让我凉快些。", "1f452"],
    ["scarf", "围巾", "My scarf is warm.", "我的围巾很暖和。", "1f9e3"],
    ["glove", "手套", "I found a glove in the snow.", "我在雪里找到了一只手套。", "1f9e4"]
  ]],
  ["travel", "一起去旅行", "#e8f3fb", [
    ["car", "汽车", "Dad is washing the car.", "爸爸在洗车。", "1f697"],
    ["bus", "公共汽车", "We go by bus.", "我们乘公共汽车去。", "1f68c"],
    ["train", "火车", "The train is at the station.", "火车在车站。", "1f686"],
    ["bicycle", "自行车", "I ride my bicycle in the park.", "我在公园里骑自行车。", "1f6b2"],
    ["boat", "小船", "The boat is on the lake.", "小船在湖上。", "1f6f6"],
    ["plane", "飞机", "We can see a plane in the sky.", "我们能看到天空中有一架飞机。", "2708"],
    ["helicopter", "直升机", "The helicopter is flying low.", "直升机飞得很低。", "1f681"],
    ["ticket", "票", "Keep your ticket safe.", "保管好你的票。", "1f3ab"],
    ["map", "地图", "Let's look at the map.", "我们看看地图吧。", "1f5fa"],
    ["suitcase", "旅行箱", "My clothes are in the suitcase.", "我的衣服在旅行箱里。", "1f9f3"]
  ]],
  ["nature", "户外发现", "#fff0e9", [
    ["sun", "太阳", "The sun is bright today.", "今天阳光明媚。", "2600"],
    ["moon", "月亮", "The moon is in the sky.", "月亮在天空中。", "1f319"],
    ["star", "星星", "I can see a bright star.", "我能看到一颗明亮的星星。", "2b50"],
    ["cloud", "云", "That cloud looks like a dog.", "那朵云看起来像一只狗。", "2601"],
    ["rain", "雨", "The rain makes the grass wet.", "雨把草淋湿了。", "1f327"],
    ["snow", "雪", "We play in the snow.", "我们在雪里玩。", "2744"],
    ["tree", "树", "The tree has green leaves.", "这棵树长着绿叶。", "1f333"],
    ["flower", "花", "This flower smells nice.", "这朵花闻起来很香。", "1f33c"],
    ["mountain", "山", "The mountain is very high.", "这座山很高。", "26f0"],
    ["beach", "海滩", "We play on the beach.", "我们在海滩上玩。", "1f3d6"]
  ]],
  ["play", "快乐活动", "#eef0fc", [
    ["football", "足球", "Let's play football.", "我们踢足球吧。", "26bd"],
    ["basketball", "篮球", "She plays basketball after school.", "她放学后打篮球。", "1f3c0"],
    ["tennis", "网球", "We play tennis on Sunday.", "我们星期天打网球。", "1f3be"],
    ["badminton", "羽毛球运动", "I play badminton with Mum.", "我和妈妈打羽毛球。", "1f3f8"],
    ["guitar", "吉他", "My brother plays the guitar.", "我哥哥弹吉他。", "1f3b8"],
    ["piano", "钢琴", "I can play the piano.", "我会弹钢琴。", "1f3b9"],
    ["camera", "照相机", "Take a photo with this camera.", "用这台照相机拍张照片。", "1f4f7"],
    ["kite", "风筝", "My kite is flying high.", "我的风筝飞得很高。", "1fa81"],
    ["balloon", "气球", "The red balloon is for you.", "红气球是给你的。", "1f388"],
    ["present", "礼物", "Thank you for the present.", "谢谢你的礼物。", "1f381"]
  ]],
  ["feelings", "身体与感受", "#fcecf1", [
    ["eye", "眼睛", "Close one eye.", "闭上一只眼睛。", "1f441"],
    ["ear", "耳朵", "My ear is cold.", "我的耳朵很冷。", "1f442"],
    ["nose", "鼻子", "Touch your nose.", "摸摸你的鼻子。", "1f443"],
    ["mouth", "嘴", "Open your mouth.", "张开你的嘴。", "1f444"],
    ["hand", "手", "Please put up your hand.", "请举手。", "270b"],
    ["foot", "脚", "My left foot hurts.", "我的左脚疼。", "1f9b6"],
    ["happy", "开心的", "I am happy to see you.", "见到你我很开心。", "1f604", "adj."],
    ["sad", "难过的", "He feels sad today.", "他今天感到难过。", "1f622", "adj."],
    ["angry", "生气的", "She is angry about the mess.", "她因为一团乱而生气。", "1f620", "adj."],
    ["tired", "疲倦的", "I am tired after the walk.", "走路之后我累了。", "1f62b", "adj."]
  ]]
];
const units = groups.map(([id, title, color, rows], index) => ({ id, title, color, number: index + 1,
  words: rows.map(([word, meaning, example, translation, art, pos = "n."]) => ({
    id: `ket-${word.toLowerCase().replace(/[^a-z]+/g, "-")}`, unitId: id, word, meaning, pos, example, translation,
    image: `/ket-assets/${art}.png`, art, kind: word.includes(" ") ? "phrase" : "word", version: 1,
    variants: word === "bicycle" ? ["bike"] : word === "plane" ? ["aeroplane", "airplane"] : []
  }))
}));
const words = units.flatMap(unit => unit.words);
module.exports = { units, words, byId: new Map(words.map(w => [w.id, w])), version: "ket-pilot-100-v1", target: 1500 };
