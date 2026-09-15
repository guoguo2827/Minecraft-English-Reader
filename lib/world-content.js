"use strict";

// Shared by the server and the renderer: coordinates refer to unit voxel cells.
const WORDS = [
  { id: "block", themeId: "concepts", word: "block", cn: "方块", icon: "box" },
  { id: "oak", themeId: "wood", word: "oak", cn: "橡木", icon: "tree-pine" },
  { id: "axe", themeId: "tools", word: "wooden axe", cn: "木斧", icon: "axe" },
  { id: "chest", themeId: "concepts", word: "chest", cn: "箱子", icon: "archive" },
  { id: "build", themeId: "verbs", word: "build", cn: "建造", icon: "hammer" },
  { id: "open", themeId: "verbs", word: "open", cn: "打开", icon: "door-open" },
  { id: "close", themeId: "verbs", word: "close", cn: "关闭", icon: "door-closed" },
  { id: "jump", themeId: "verbs", word: "jump", cn: "跳跃", icon: "arrow-up" }
];
const GROUPS = [
  { id: "materials", title: "认识材料", words: ["block", "oak"], reward: { planks: 8 } },
  { id: "tools", title: "认识工具", words: ["axe", "chest"], reward: { oak: 4 } },
  { id: "building", title: "开始建造", words: ["build", "jump"], reward: { planks: 8 } },
  { id: "home", title: "完成营地", words: ["open", "close"], reward: { planks: 8 } }
];
const PHRASE_IDS = [9, 22, 23, 24, 25, 29, 32, 78];
const ITEMS = {
  planks: { name: "木板", english: "planks", icon: "layers", color: "#d4a35e" },
  oak: { name: "橡木", english: "oak", icon: "tree-pine", color: "#977244" },
  workbench: { name: "工作台", english: "crafting table", icon: "hammer", color: "#b67b43" },
  axe: { name: "木斧", english: "wooden axe", icon: "axe", color: "#76989f" },
  chest: { name: "箱子", english: "chest", icon: "archive", color: "#ba853f" },
  door: { name: "木门", english: "door", icon: "door-open", color: "#cc9353" }
};
const RECIPES = [
  { id: "planks", costs: { oak: 1 }, count: 4, starter: true },
  { id: "workbench", costs: { planks: 4 }, count: 1 },
  { id: "axe", costs: { planks: 3, oak: 1 }, count: 1 },
  { id: "chest", costs: { planks: 8 }, count: 1 },
  { id: "door", costs: { planks: 6 }, count: 1 }
];
const SIZE = { x: 64, y: 24, z: 64 };
const SPAWN = { x: 31.5, y: 4.95, z: 43.5, yaw: 0, pitch: -0.08 };
const PLOT = { minX: 34, maxX: 49, minZ: 9, maxZ: 24, minY: 4, maxY: 15 };
const STATIONS = {
  axe: [26, 4, 28], chest: [28, 4, 23], workbench: [33, 4, 26], door: [21, 4, 21],
  jump: [30, 4, 18], step: [30, 4, 20]
};
const RESOURCES = [[25, 4, 41], [23, 4, 27], [17, 4, 27], [17, 4, 11], [51, 4, 18], [46, 4, 28]];
const BRIDGE = [];
for (let x = 31; x <= 32; x++) for (let z = 32; z <= 34; z++) BRIDGE.push([x, 3, z]);
const HOUSE = [];
for (let x = 38; x <= 42; x++) for (let z = 15; z <= 19; z++) {
  HOUSE.push({ pos: [x, 4, z], item: "planks", part: "floor" });
  HOUSE.push({ pos: [x, 8, z], item: "planks", part: "roof" });
  if (x === 38 || x === 42 || z === 15 || z === 19) {
    for (let y = 5; y <= 7; y++) {
      if (x === 40 && z === 19 && y < 7) continue;
      HOUSE.push({ pos: [x, y, z], item: "planks", part: "wall" });
    }
  }
}
HOUSE.push({ pos: [40, 5, 19], item: "door", part: "door" });
HOUSE.push({ pos: [39, 5, 16], item: "chest", part: "chest" });
const BLOCK = { AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, OAK: 4, LEAF: 5, PLANKS: 6, PATH: 7, ROOF: 8 };
const key = (pos) => pos.join(",");
const insidePlot = ([x, y, z]) => x >= PLOT.minX && x <= PLOT.maxX && z >= PLOT.minZ && z <= PLOT.maxZ && y >= PLOT.minY && y <= PLOT.maxY;
const index = (x, y, z) => x + SIZE.x * (z + SIZE.z * y);

function makeTerrain() {
  const voxels = new Uint8Array(SIZE.x * SIZE.y * SIZE.z);
  const put = (x, y, z, value) => { if (x >= 0 && x < 64 && z >= 0 && z < 64 && y >= 0 && y < 24) voxels[index(x, y, z)] = value; };
  for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) {
    const distance = Math.hypot((x - 32) / 1.04, z - 31);
    if (distance > 28) continue;
    const river = z >= 32 && z <= 34;
    for (let y = 0; y <= (river ? 1 : 3); y++) put(x, y, z, y === 3 ? BLOCK.GRASS : (y === 0 ? BLOCK.STONE : BLOCK.DIRT));
    if (!river && x >= 30 && x <= 33 && z >= 24 && z <= 47) put(x, 3, z, BLOCK.PATH);
  }
  for (const [x, , z] of RESOURCES) {
    for (let y = 4; y <= 7; y++) put(x, y, z, BLOCK.OAK);
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let y = 7; y <= 9; y++) {
      if (Math.abs(dx) + Math.abs(dz) < 4 && (dx || dz || y > 7)) put(x + dx, y, z + dz, BLOCK.LEAF);
    }
  }
  // A protected demonstration cabin, with its interactive door rendered separately.
  for (let x = 19; x <= 23; x++) for (let z = 16; z <= 21; z++) {
    if (x === 19 || x === 23 || z === 16 || z === 21) for (let y = 4; y <= 6; y++) {
      if (x === 21 && z === 21 && y < 6) continue;
      put(x, y, z, BLOCK.PLANKS);
    }
    put(x, 7, z, BLOCK.ROOF);
  }
  return voxels;
}
function baseBlock(terrain, [x, y, z]) {
  if (x < 0 || x >= 64 || y < 0 || y >= 24 || z < 0 || z >= 64) return BLOCK.AIR;
  return terrain[index(x, y, z)];
}
module.exports = { WORDS, GROUPS, PHRASE_IDS, ITEMS, RECIPES, SIZE, SPAWN, PLOT, STATIONS, RESOURCES, BRIDGE, HOUSE, BLOCK, key, index, insidePlot, makeTerrain, baseBlock };
