import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import RAPIER from "@dimforge/rapier3d-compat";
import C from "../lib/world-content.js";
import { terrainAtlas, itemModel, labelSprite } from "./art.js";

const faces = [
  { normal: [1,0,0], shade: .86, corners: [[1,0,1],[1,0,0],[1,1,1],[1,1,0]] },
  { normal: [-1,0,0], shade: .72, corners: [[0,0,0],[0,0,1],[0,1,0],[0,1,1]] },
  { normal: [0,1,0], shade: 1, corners: [[0,1,1],[1,1,1],[0,1,0],[1,1,0]] },
  { normal: [0,-1,0], shade: .55, corners: [[1,0,1],[0,0,1],[1,0,0],[0,0,0]] },
  { normal: [0,0,1], shade: .91, corners: [[0,0,1],[1,0,1],[0,1,1],[1,1,1]] },
  { normal: [0,0,-1], shade: .78, corners: [[1,0,0],[0,0,0],[1,1,0],[0,1,0]] }
];
const dispose = (object) => object.traverse(child => {
  child.geometry?.dispose();
  if (child.material) for(const material of (Array.isArray(child.material)?child.material:[child.material])) { material.map?.dispose();material.dispose(); }
});

export class CampScene {
  constructor(canvas, { onTarget, onJump, onInteract, onRemove, onPause, onMove }) {
    this.canvas=canvas;this.callbacks={onTarget,onJump,onInteract,onRemove,onPause,onMove};
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:"high-performance"});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio,1.5));
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.22;
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color(0xa6dbe4);this.scene.fog=new THREE.Fog(0xa6dbe4,38,100);
    this.camera=new THREE.PerspectiveCamera(64,1,.1,140);this.camera.rotation.order="YXZ";
    this.scene.add(new THREE.HemisphereLight(0xeafaff,0x819262,2.3));
    const sun=new THREE.DirectionalLight(0xfff2d1,2.2);sun.position.set(-20,45,25);this.scene.add(sun);
    const atlas=terrainAtlas();this.atlas=atlas;
    this.terrainMaterial=new THREE.MeshLambertMaterial({map:atlas.texture,vertexColors:true});
    this.base=C.makeTerrain();this.voxels=this.base.slice();this.chunks=new Map();this.objects=new THREE.Group();this.scene.add(this.objects);
    this.markers=new THREE.Group();this.scene.add(this.markers);this.guides=new THREE.Group();this.scene.add(this.guides);
    this.raycaster=new THREE.Raycaster();this.raycaster.far=7;
    this.keys=new Set();this.joystick={x:0,z:0};this.velocityY=0;this.yaw=0;this.pitch=-.08;
    this.active=false;this.guideVisible=true;this.pendingJump=false;this.position={...C.SPAWN};this.state=null;
    this.target=null;this.objectColliders=[];this.touchId=null;this.lastTargetKey="";this.accumulator=0;this.frames=0;
    this.water=new THREE.Mesh(new THREE.PlaneGeometry(150,150),new THREE.MeshLambertMaterial({color:0x63b8c3,transparent:true,opacity:.84}));
    this.water.rotation.x=-Math.PI/2;this.water.position.set(32,2.27,32);this.scene.add(this.water);
    this.createScenery();this.bindControls();
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(canvas);this.resize();
  }
  async init() {
    await RAPIER.init();
    this.physics=new RAPIER.World({x:0,y:-18,z:0});
    const bodyDesc=RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(C.SPAWN.x,C.SPAWN.y,C.SPAWN.z);
    this.body=this.physics.createRigidBody(bodyDesc);
    this.playerCollider=this.physics.createCollider(RAPIER.ColliderDesc.capsule(.55,.3),this.body);
    this.controller=this.physics.createCharacterController(.025);
    this.controller.enableAutostep(1.05,.25,false);this.controller.enableSnapToGround(.3);
    for(let cx=0;cx<4;cx++)for(let cz=0;cz<4;cz++)this.rebuildChunk(cx,cz);
    this.physics.step();this.setPosition(C.SPAWN);
    this.lastTime=performance.now();this.renderer.setAnimationLoop(time=>this.frame(time));
  }
  createScenery() {
    const clouds=new THREE.Group();const cloudMat=new THREE.MeshLambertMaterial({color:0xf7ffff,transparent:true,opacity:.92});
    for(let i=0;i<10;i++) {
      const cloud=new THREE.Group();
      for(let j=0;j<3;j++){const block=new THREE.Mesh(new THREE.BoxGeometry(4+j%2*3,1.2+j*.25,2.5+j%2*2),cloudMat);block.position.set(j*3,j%2*.3,0);cloud.add(block);}
      cloud.position.set(-20+(i*19)%110,22+(i%3)*3,-15+(i*37)%95);clouds.add(cloud);
    }
    clouds.updateMatrixWorld(true);
    const cloudGeometries=[];clouds.traverse(child=>{if(child.isMesh)cloudGeometries.push(child.geometry.clone().applyMatrix4(child.matrixWorld));});
    this.clouds=new THREE.Mesh(mergeGeometries(cloudGeometries),cloudMat);this.scene.add(this.clouds);
    for(const geometry of cloudGeometries)geometry.dispose();
    clouds.traverse(child=>child.geometry?.dispose());
    const flowers=new THREE.Group();
    const stemMat=new THREE.MeshLambertMaterial({color:0x56814a});
    const flowerMats=[0xf2cf72,0xeaa3b1,0xf7eee1].map(color=>new THREE.MeshLambertMaterial({color}));
    for(let i=0;i<90;i++) {
      const x=9+(i*13.73)%46,z=8+(i*17.37)%45;
      if(this.base[C.index(Math.floor(x),3,Math.floor(z))]!==C.BLOCK.GRASS || C.insidePlot([Math.floor(x),4,Math.floor(z)]) || (x>18&&x<24&&z>15&&z<23)) continue;
      const stem=new THREE.Mesh(new THREE.BoxGeometry(.055,.3,.055),stemMat);stem.position.set(x,4.15,z);flowers.add(stem);
      const flower=new THREE.Mesh(new THREE.BoxGeometry(.21,.09,.21),flowerMats[i%3]);flower.position.set(x,4.32,z);flowers.add(flower);
    }
    flowers.updateMatrixWorld(true);
    for(const material of [stemMat,...flowerMats]){
      const geometries=flowers.children.filter(child=>child.material===material).map(child=>child.geometry.clone().applyMatrix4(child.matrixWorld));
      if(geometries.length)this.scene.add(new THREE.Mesh(mergeGeometries(geometries),material));
      for(const geometry of geometries)geometry.dispose();
    }
    flowers.traverse(child=>child.geometry?.dispose());
    const plotLine=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(16,.04,16)),new THREE.LineBasicMaterial({color:0xf5e2a6}));plotLine.position.set(42,4.025,17);this.scene.add(plotLine);
    const sign=(text,pos)=>{const sprite=labelSprite(text);sprite.position.set(...pos);this.scene.add(sprite);};
    sign("晨光营地",[31.5,6.1,35.5]);sign("公共工作台",[33.5,6.3,26.5]);sign("我的建造区",[42,5.6,24.4]);sign("教学小屋",[21.5,8.1,21.5]);
    const archMat=new THREE.MeshLambertMaterial({color:0xb1c08b});
    for(const x of [29.8,33.8]){const post=new THREE.Mesh(new THREE.BoxGeometry(.18,2.6,.18),archMat);post.position.set(x,5.3,35.5);this.scene.add(post);}
    const beam=new THREE.Mesh(new THREE.BoxGeometry(4.2,.15,.16),archMat);beam.position.set(31.8,6.6,35.5);this.scene.add(beam);
  }
  resize(){const w=this.canvas.clientWidth,h=this.canvas.clientHeight;this.camera.aspect=w/Math.max(h,1);this.camera.updateProjectionMatrix();this.renderer.setSize(w,h,false);}
  blockAt(x,y,z){return C.baseBlock(this.voxels,[x,y,z]);}
  rebuildChunk(cx,cz) {
    if(cx<0||cx>=4||cz<0||cz>=4)return;
    const chunkKey=`${cx},${cz}`;
    const previous=this.chunks.get(chunkKey);
    if(previous){this.scene.remove(previous.mesh);previous.mesh.geometry.dispose();if(previous.collider)this.physics.removeCollider(previous.collider,true);}
    const positions=[],normals=[],uvs=[],colors=[],indices=[];
    for(let x=cx*16;x<cx*16+16;x++)for(let z=cz*16;z<cz*16+16;z++)for(let y=0;y<24;y++) {
      const type=this.blockAt(x,y,z);if(!type)continue;
      for(const face of faces){
        const [nx,ny,nz]=face.normal;if(this.blockAt(x+nx,y+ny,z+nz))continue;
        const start=positions.length/3;
        const textureType=type===C.BLOCK.GRASS&&ny!==1 ? C.BLOCK.DIRT : type;
        face.corners.forEach((p,i)=>{
          positions.push(x+p[0],y+p[1],z+p[2]);normals.push(nx,ny,nz);
          uvs.push((textureType+(i%2?.98:.02))/this.atlas.count,i<2?.02:.98);
          colors.push(face.shade,face.shade,face.shade);
        });
        indices.push(start,start+1,start+2,start+2,start+1,start+3);
      }
    }
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute("normal",new THREE.Float32BufferAttribute(normals,3));geometry.setAttribute("uv",new THREE.Float32BufferAttribute(uvs,2));geometry.setAttribute("color",new THREE.Float32BufferAttribute(colors,3));geometry.setIndex(indices);geometry.computeBoundingSphere();
    const mesh=new THREE.Mesh(geometry,this.terrainMaterial);mesh.userData.kind="terrain";this.scene.add(mesh);
    const collider=indices.length?this.physics.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(positions),new Uint32Array(indices))):null;
    this.chunks.set(chunkKey,{mesh,collider});
  }
  setState(snapshot,{restorePosition=false}={}) {
    const state=snapshot.state,previous=this.state;
    const changed=new Set();
    const oldBlocks=previous?.blocks||{};
    for(const k of new Set([...Object.keys(oldBlocks),...Object.keys(state.blocks)])) {
      if(oldBlocks[k]===state.blocks[k])continue;
      const [x,y,z]=k.split(",").map(Number);
      const value=state.blocks[k]==="planks"?C.BLOCK.PLANKS:state.blocks[k]==="oak"?C.BLOCK.OAK:this.base[C.index(x,y,z)];
      this.voxels[C.index(x,y,z)]=value;
      for(const [dx,dz] of [[0,0],[-1,0],[1,0],[0,-1],[0,1]]) changed.add(`${Math.floor((x+dx)/16)},${Math.floor((z+dz)/16)}`);
    }
    this.state=state;this.snapshot=snapshot;
    for(const k of changed)this.rebuildChunk(...k.split(",").map(Number));
    this.rebuildObjects();this.rebuildGuides();
    if(restorePosition)this.setPosition(state.position);
    this.physics.step();
  }
  rebuildObjects() {
    this.scene.remove(this.objects);dispose(this.objects);this.objects=new THREE.Group();this.scene.add(this.objects);
    for(const collider of this.objectColliders)this.physics.removeCollider(collider,true);this.objectColliders=[];
    const add=(type,pos,action)=>{
      const open=!!this.state.doors[C.key(pos)];const model=itemModel(type,open);model.position.set(...pos);model.userData={kind:"object",type,pos,action};this.objects.add(model);
      if(type!=="axe") {
        const half=type==="door"?{x:open?.07:.47,y:.96,z:open?.47:.07}:{x:.46,y:.47,z:.46};
        const at=type==="door"&&open?{x:pos[0]+.05,y:pos[1]+.96,z:pos[2]+.88}:{x:pos[0]+.5,y:pos[1]+(type==="door"?.96:.47),z:pos[2]+.5};
        this.objectColliders.push(this.physics.createCollider(RAPIER.ColliderDesc.cuboid(half.x,half.y,half.z).setTranslation(at.x,at.y,at.z)));
      }
    };
    add("axe",C.STATIONS.axe,"borrow");add("chest",C.STATIONS.chest,"inspect");add("workbench",C.STATIONS.workbench,"workbench");add("door",C.STATIONS.door,"door");
    for(const [k,item] of Object.entries(this.state.blocks))if(["door","chest","workbench"].includes(item))add(item,k.split(",").map(Number),item==="door"?"door":item==="workbench"?"workbench":"own-chest");
    C.RESOURCES.forEach((pos,nodeId)=>{
      const label=labelSprite("oak","#fff7cf",128);label.position.set(pos[0]+.5,pos[1]+2.8,pos[2]+.5);this.objects.add(label);
      const target=new THREE.Mesh(new THREE.BoxGeometry(1.06,3.1,1.06),new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false}));
      target.position.set(pos[0]+.5,pos[1]+1.5,pos[2]+.5);target.userData={kind:"resource",nodeId,pos};this.objects.add(target);
    });
  }
  rebuildGuides() {
    this.scene.remove(this.guides);dispose(this.guides);this.guides=new THREE.Group();this.scene.add(this.guides);
    const cells=[];
    for(const pos of C.BRIDGE)if(!this.state.blocks[C.key(pos)])cells.push({pos,item:"planks"});
    if(!this.state.blocks[C.key(C.STATIONS.step)])cells.push({pos:C.STATIONS.step,item:"planks"});
    if(this.guideVisible && !this.state.completedAt) {
      const order=["floor","wall","roof","door","chest"];
      const next=order.find(part=>C.HOUSE.some(c=>c.part===part && this.state.blocks[C.key(c.pos)]!==c.item));
      for(const cell of C.HOUSE)if(cell.part===next&&!this.state.blocks[C.key(cell.pos)])cells.push(cell);
    }
    for(const height of [1,2]){
      const batch=cells.filter(cell=>(cell.item==="door"?2:1)===height);if(!batch.length)continue;
      const geometry=new THREE.BoxGeometry(.96,height-.04,.96),edgeGeometries=[];
      const mesh=new THREE.InstancedMesh(geometry,new THREE.MeshBasicMaterial({color:0xf5df9c,opacity:.07,transparent:true,depthWrite:false}),batch.length);
      mesh.userData={kind:"guide-batch",cells:batch};
      batch.forEach((cell,i)=>{
        const matrix=new THREE.Matrix4().makeTranslation(cell.pos[0]+.5,cell.pos[1]+height/2,cell.pos[2]+.5);
        mesh.setMatrixAt(i,matrix);edgeGeometries.push(new THREE.EdgesGeometry(geometry).applyMatrix4(matrix));
      });
      this.guides.add(mesh,new THREE.LineSegments(mergeGeometries(edgeGeometries),new THREE.LineBasicMaterial({color:0xf5df9c,opacity:.8,transparent:true})));
      for(const edge of edgeGeometries)edge.dispose();
    }
  }
  setGuide(visible){this.guideVisible=visible;this.rebuildGuides();}
  setPosition(pos){this.position={...pos};this.yaw=pos.yaw;this.pitch=pos.pitch;this.velocityY=0;this.body?.setTranslation(pos,true);this.body?.setNextKinematicTranslation(pos);this.updateCamera();}
  getPosition(){return {...this.position,yaw:this.yaw,pitch:this.pitch};}
  captureHouse(){
    const camera=new THREE.PerspectiveCamera(48,this.camera.aspect,.1,140);
    camera.position.set(49,12,29);camera.lookAt(40.5,6.3,17.5);
    this.renderer.render(this.scene,camera);
    const picture=this.canvas.toDataURL("image/png");
    this.renderer.render(this.scene,this.camera);return picture;
  }
  updateCamera(){this.camera.position.set(this.position.x,this.position.y+.65,this.position.z);this.camera.rotation.set(this.pitch,this.yaw,0,"YXZ");}
  setActive(active){this.active=active;this.keys.clear();this.joystick={x:0,z:0};this.pendingJump=false;if(!active){this.jumpStart=null;if(document.pointerLockElement===this.canvas)document.exitPointerLock();}}
  lockPointer(){if(!matchMedia("(pointer:coarse)").matches)this.canvas.requestPointerLock?.()?.catch?.(()=>{});}
  jump(){if(this.active)this.pendingJump=true;}
  bindControls(){
    window.addEventListener("keydown",e=>{
      if(!this.active || /INPUT|TEXTAREA/.test(e.target.tagName))return;
      if(["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.code))e.preventDefault();
      this.keys.add(e.code);if(e.code==="Space"&&!e.repeat)this.jump();
      if(e.code==="KeyE"&&!e.repeat)this.callbacks.onInteract(this.target);
    });
    window.addEventListener("keyup",e=>this.keys.delete(e.code));
    window.addEventListener("blur",()=>{this.keys.clear();this.joystick={x:0,z:0};});
    document.addEventListener("pointerlockchange",()=>{if(document.pointerLockElement!==this.canvas){this.keys.clear();if(this.active)this.callbacks.onPause();}});
    document.addEventListener("mousemove",e=>{if(this.active&&document.pointerLockElement===this.canvas)this.look(e.movementX,e.movementY);});
    this.canvas.addEventListener("contextmenu",e=>e.preventDefault());
    this.canvas.addEventListener("pointerdown",e=>{
      if(!this.active)return;
      if(e.pointerType==="touch"){this.touchId=e.pointerId;this.touchPoint={x:e.clientX,y:e.clientY};this.canvas.setPointerCapture(e.pointerId);return;}
      if(document.pointerLockElement!==this.canvas){this.lockPointer();return;}
      if(e.button===0)this.callbacks.onInteract(this.target);if(e.button===2)this.callbacks.onRemove(this.target);
    });
    this.canvas.addEventListener("pointermove",e=>{if(this.active&&e.pointerId===this.touchId){this.look(e.clientX-this.touchPoint.x,e.clientY-this.touchPoint.y,.005);this.touchPoint={x:e.clientX,y:e.clientY};}});
    const clear=e=>{if(e.pointerId===this.touchId)this.touchId=null;};this.canvas.addEventListener("pointerup",clear);this.canvas.addEventListener("pointercancel",clear);
  }
  look(dx,dy,sensitivity=.0025){this.yaw-=dx*sensitivity;this.yaw=((this.yaw+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;this.pitch=THREE.MathUtils.clamp(this.pitch-dy*sensitivity,-1.45,1.45);}
  targetAtCenter() {
    this.raycaster.setFromCamera(new THREE.Vector2(0,0),this.camera);
    const hits=this.raycaster.intersectObjects([...Array.from(this.chunks.values(),c=>c.mesh),this.objects,this.guides],true);
    for(const hit of hits){
      if(hit.object.isLine || hit.object.isSprite)continue;
      let parent=hit.object;while(parent&&!parent.userData.kind)parent=parent.parent;
      if(!parent)continue;
      const data=parent.userData;
      if(data.kind==="guide-batch")return {kind:"guide",...data.cells[hit.instanceId]};
      if(data.kind==="terrain") {
        const p=hit.point.clone().addScaledVector(hit.face.normal,-.001);
        const pos=[Math.floor(p.x),Math.floor(p.y),Math.floor(p.z)];
        const resource=C.RESOURCES.findIndex(([x,,z])=>pos[0]===x&&pos[2]===z&&pos[1]>=4&&pos[1]<=7);
        if(resource>=0)return {kind:"resource",nodeId:resource,pos:C.RESOURCES[resource]};
        const place=hit.point.clone().addScaledVector(hit.face.normal,.001);
        return {kind:"terrain",pos,place:[Math.floor(place.x),Math.floor(place.y),Math.floor(place.z)],item:this.state?.blocks[C.key(pos)]};
      }
      return {...data};
    }
    return null;
  }
  simulate(dt) {
    this.physics.timestep=dt;
    const dx=(this.keys.has("KeyD")||this.keys.has("ArrowRight")?1:0)-(this.keys.has("KeyA")||this.keys.has("ArrowLeft")?1:0)+this.joystick.x;
    const dz=(this.keys.has("KeyS")||this.keys.has("ArrowDown")?1:0)-(this.keys.has("KeyW")||this.keys.has("ArrowUp")?1:0)+this.joystick.z;
    const scale=Math.max(1,Math.hypot(dx,dz)),speed=4.4;
    const vx=(dx*Math.cos(this.yaw)+dz*Math.sin(this.yaw))/scale*speed;
    const vz=(dz*Math.cos(this.yaw)-dx*Math.sin(this.yaw))/scale*speed;
    const grounded=this.controller.computedGrounded();
    if(grounded&&this.velocityY<0)this.velocityY=-.3;
    if(this.pendingJump&&grounded){this.velocityY=7;this.jumpStart=this.getPosition();this.jumpPeak=this.position.y;this.jumpAirborne=false;}
    this.pendingJump=false;this.velocityY=Math.max(-18,this.velocityY-18*dt);
    this.controller.computeColliderMovement(this.playerCollider,{x:vx*dt,y:this.velocityY*dt,z:vz*dt});
    const movement=this.controller.computedMovement(),old=this.body.translation();
    const next={x:old.x+movement.x,y:old.y+movement.y,z:old.z+movement.z};
    this.body.setNextKinematicTranslation(next);this.physics.step();this.position={...next};
    if(this.jumpStart){
      this.jumpPeak=Math.max(this.jumpPeak,next.y);
      if(!this.controller.computedGrounded())this.jumpAirborne=true;
      if(this.jumpAirborne&&this.controller.computedGrounded()){
        this.callbacks.onJump({from:this.jumpStart,to:this.getPosition(),peak:this.jumpPeak});this.jumpStart=null;
      }
    }
    if(next.y<2.4||next.x<4||next.x>60||next.z<4||next.z>60)this.setPosition(C.SPAWN);
    if(Math.abs(dx)+Math.abs(dz)>.05)this.callbacks.onMove?.();
  }
  frame(time) {
    const dt=Math.min(.05,(time-this.lastTime)/1000);this.lastTime=time;
    if(this.active){this.accumulator+=dt;let steps=0;while(this.accumulator>=1/60&&steps++<4){this.simulate(1/60);this.accumulator-=1/60;}}
    else this.accumulator=0;
    this.updateCamera();
    if(!matchMedia("(prefers-reduced-motion:reduce)").matches){this.clouds.position.x=Math.sin(time*.000025)*3;this.water.position.y=2.27+Math.sin(time*.0006)*.035;}
    if(this.active && this.state) {
      this.target=this.targetAtCenter();const k=JSON.stringify(this.target);
      if(k!==this.lastTargetKey){this.lastTargetKey=k;this.callbacks.onTarget(this.target);}
    }
    this.renderer.render(this.scene,this.camera);
    this.frames++;
    if(this.frames%30===0){this.canvas.dataset.frames=String(this.frames);this.canvas.dataset.drawCalls=String(this.renderer.info.render.calls);}
  }
  destroy(){this.renderer.setAnimationLoop(null);this.resizeObserver.disconnect();this.physics?.free();this.renderer.dispose();}
}
