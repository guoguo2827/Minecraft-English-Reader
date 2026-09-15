import * as THREE from "three";

const palette = ["#ffffff", "#87ad59", "#9e7e55", "#81948b", "#b38550", "#649450", "#d3b27c", "#c4c29b", "#629ea5"];
export function terrainAtlas() {
  const canvas = document.createElement("canvas"); canvas.width = 32 * palette.length; canvas.height = 32;
  const ctx = canvas.getContext("2d");
  let seed = 137;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  palette.forEach((color, i) => {
    ctx.fillStyle = color; ctx.fillRect(i * 32, 0, 32, 32);
    for (let p = 0; p < 55; p++) {
      ctx.fillStyle = rand() > .5 ? "#ffffff14" : "#173b3220";
      ctx.fillRect(i * 32 + Math.floor(rand() * 15) * 2, Math.floor(rand() * 15) * 2, 2 + Math.floor(rand() * 3), 2);
    }
    if (i === 6 || i === 8) {
      ctx.fillStyle = "#55432335";
      for (let y = 7; y < 32; y += 8) ctx.fillRect(i * 32, y, 32, 1);
      ctx.fillRect(i * 32 + 13, 0, 1, 8); ctx.fillRect(i * 32 + 23, 8, 1, 8); ctx.fillRect(i * 32 + 7, 16, 1, 8);
    }
    if (i === 4) {
      ctx.fillStyle = "#513b292f";
      for (let x = 3; x < 32; x += 7) ctx.fillRect(i * 32 + x, 0, 2, 32);
    }
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter; texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, count: palette.length };
}

const sprites = new Map();
export function itemSprite(id) {
  if (sprites.has(id)) return sprites.get(id);
  const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 64;
  const c = canvas.getContext("2d");
  const polygon = (points, fill) => { c.fillStyle = fill; c.beginPath(); points.forEach(([x,y],i) => i ? c.lineTo(x,y) : c.moveTo(x,y)); c.closePath(); c.fill(); };
  if (id === "axe") {
    polygon([[30,21],[37,25],[19,57],[12,53]], "#a67b42");
    polygon([[26,10],[44,9],[55,20],[47,33],[29,29],[20,21]], "#779996");
    polygon([[26,10],[44,9],[55,20],[39,22]], "#bdd0bc");
    polygon([[26,20],[37,24],[29,32],[21,27]], "#825e37");
  } else if (id === "door") {
    polygon([[19,9],[45,5],[45,52],[19,58]], "#865f39");
    polygon([[15,8],[41,4],[41,51],[15,57]], "#d3a964");
    c.fillStyle="#577d71";c.fillRect(21,14,13,12);c.fillStyle="#865a32";c.fillRect(20,34,14,14);c.fillStyle="#fbe1a2";c.fillRect(35,29,4,4);
  } else {
    const colors = id === "oak" ? ["#d4b17e","#9e7245","#bb8b52"] : id === "chest" ? ["#e0bc70","#98743c","#c39852"] : id === "workbench" ? ["#b99063","#78533a","#a67c4f"] : ["#e3c798","#b59866","#d0b481"];
    polygon([[9,20],[32,8],[56,20],[33,32]],colors[0]);
    polygon([[9,20],[33,32],[33,58],[9,45]],colors[1]);
    polygon([[33,32],[56,20],[56,45],[33,58]],colors[2]);
    c.strokeStyle="#674c2a66";c.lineWidth=2;
    if (id === "planks" || id === "workbench") for(let y=28;y<45;y+=8){c.beginPath();c.moveTo(9,y);c.lineTo(33,y+12);c.lineTo(56,y);c.stroke();}
    if (id === "oak") for(let x=15;x<29;x+=6){c.beginPath();c.moveTo(x,24);c.lineTo(x,46);c.stroke();}
    if (id === "chest") {c.fillStyle="#715934";c.fillRect(33,32,23,4);c.fillStyle="#f7dd8a";c.fillRect(41,33,6,9);}
    if (id === "workbench") {polygon([[18,20],[32,13],[47,20],[33,27]],"#5f7766");}
  }
  const uri=canvas.toDataURL(); sprites.set(id,uri); return uri;
}

export function labelSprite(text, color = "#faffef", width = 256) {
  const canvas=document.createElement("canvas");canvas.width=width;canvas.height=64;
  const ctx=canvas.getContext("2d");ctx.fillStyle="#244d40dd";ctx.fillRect(0,0,width,64);
  ctx.fillStyle=color;ctx.font='bold 25px "Segoe UI", "Microsoft YaHei", sans-serif';ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(text,width/2,33,width-24);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthTest:true}));sprite.scale.set(width/110,.58,1);return sprite;
}

export function itemModel(type, open = false) {
  const group=new THREE.Group();
  const materials=new Map();
  const box=(x,y,z,w,h,d,color)=>{
    if(!materials.has(color)) materials.set(color,new THREE.MeshLambertMaterial({color}));
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),materials.get(color));mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);return mesh;
  };
  if(type==="door") {
    const pivot=new THREE.Group();
    box(.47,.94,.5,.09,1.88,.12,0x7b6742);
    const panel=box(.48,.92,.5,.78,1.78,.1,0xd2ad65);group.remove(panel);pivot.add(panel);panel.position.x=.39;panel.position.z=0;
    const knob=box(.78,.93,.57,.08,.08,.08,0xffdf81);group.remove(knob);pivot.add(knob);knob.position.x=.68;knob.position.z=.08;
    for(let i=0;i<3;i++){const slat=box(0,0,0,.025,1.6,.12,0xa48551);group.remove(slat);pivot.add(slat);slat.position.set(.15+i*.22,.92,0);}
    pivot.position.set(.05,0,.5);pivot.rotation.y=open ? -Math.PI/2 : 0;group.add(pivot);
  } else if(type==="chest") {
    box(.5,.33,.5,.84,.59,.7,0xbb995c);box(.5,.69,.5,.89,.2,.76,0xd1b674);
    box(.5,.57,.5,.9,.055,.78,0x695b3c);box(.5,.51,.905,.12,.22,.06,0xf5d970);
  } else if(type==="workbench") {
    box(.5,.87,.5,.98,.22,.98,0xc19d6d);box(.5,.99,.5,.66,.035,.65,0x638477);
    for(const x of [.16,.84])for(const z of [.16,.84])box(x,.39,z,.17,.75,.17,0x946d46);
    box(.5,.25,.5,.77,.1,.77,0xb58d54);
  } else if(type==="axe") {
    box(.5,.65,.5,.14,.95,.14,0xac7b42);box(.66,1.03,.5,.57,.39,.14,0x9da995);box(.78,1.03,.5,.12,.44,.18,0xc4c9af);
    box(.5,.12,.5,.8,.22,.8,0x7a9884);
  }
  return group;
}
