// 脚底对应 pearl-yaw-v02 1536×1024 母版；右侧高起舱盖不是同层可走平台。
export const DECK_POINTS = [
  [390,550],[473,553],[520,555],[650,708],[774,735],
  [918,755],[1034,785],[1069,765],[1043,739],[970,787],
  [916,700],[808,739],[609,632],[598,570],[706,721],
  [938,771],[855,750],[425,578],[607,689],[1112,789],
  [1098,748],[1125,712],[1156,672],[1145,622],[1206,695],
];
export const DECK_EDGES = [
  [0,1],[0,17],[17,1],[1,2],[2,13],
  [13,12],[12,18],[18,3],[3,14],[14,4],
  [4,11],[11,16],[16,5],[5,10],[10,15],
  [15,5],[5,9],[9,6],[6,7],[7,19],
  [19,6],[7,8],[8,6],[7,20],[20,21],
  [21,22],[22,23],[22,24],
];
export const TRANSIT_NODES=[20,21,22];
export const DECK_LEVELS=DECK_POINTS.map((_,node)=>node<=20?0:node===21?.5:1);
export const canStopDeckNode=node=>!!DECK_POINTS[node]&&!TRANSIT_NODES.includes(node);
const roamingStops=DECK_POINTS.map((_,node)=>node).filter(canStopDeckNode);
const deckLinks=DECK_POINTS.map((_,node)=>DECK_EDGES.filter(edge=>edge.includes(node)).map(edge=>edge[0]===node?edge[1]:edge[0]));
export const CREW_STOPS = {jack:roamingStops,barbossa:roamingStops,elizabeth:roamingStops};
export const MIN_SEPARATION = 44;
let requestOrder = 0;
const distance = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);
const position = walker => [walker.x,walker.y];
const inPassage=walker=>TRANSIT_NODES.includes(walker.node)||TRANSIT_NODES.includes(walker.segment?.from)||TRANSIT_NODES.includes(walker.segment?.to);
export function deckElevation(walker){
  if(!walker.segment)return DECK_LEVELS[walker.node];
  const {from,to}=walker.segment,length=distance(DECK_POINTS[from],DECK_POINTS[to]);
  return DECK_LEVELS[from]+(DECK_LEVELS[to]-DECK_LEVELS[from])*Math.min(1,distance(DECK_POINTS[from],position(walker))/length);
}
export const sameDeckLevel=(left,right)=>!left.segment&&!right.segment&&canStopDeckNode(left.node)&&canStopDeckNode(right.node)&&DECK_LEVELS[left.node]===DECK_LEVELS[right.node];
function passageExit(walker){
  const start=walker.next??walker.node,previous=walker.segment?(start===walker.segment.from?walker.segment.to:walker.segment.from):null;
  const pending=[start],seen=new Set(previous===null?[]:[previous]);
  for(const node of pending){
    if(seen.has(node))continue;seen.add(node);
    if(canStopDeckNode(node))return node;
    pending.push(...deckLinks[node].filter(next=>!seen.has(next)));
  }
  return previous;
}
export function segmentDistance(point,from,to) {
  const dx=to[0]-from[0],dy=to[1]-from[1],length=dx*dx+dy*dy;
  const t=length?Math.max(0,Math.min(1,((point[0]-from[0])*dx+(point[1]-from[1])*dy)/length)):0;
  return Math.hypot(point[0]-from[0]-t*dx,point[1]-from[1]-t*dy);
}
const clear = (from,to,peers) => peers.every(peer=>segmentDistance(position(peer),from,to)>=MIN_SEPARATION-.001);
export function deckRoute(from,to,peers=[]) {
  if(!DECK_POINTS[from]||!DECK_POINTS[to])return [];
  const dist=DECK_POINTS.map(()=>Infinity),previous=[],pending=new Set(DECK_POINTS.map((_,i)=>i));
  dist[from]=0;
  while(pending.size){
    const node=[...pending].reduce((a,b)=>dist[a]<=dist[b]?a:b);
    pending.delete(node);if(!Number.isFinite(dist[node])||node===to)break;
    for(const edge of DECK_EDGES){
      if(!edge.includes(node))continue;
      const next=edge[0]===node?edge[1]:edge[0];
      if(!pending.has(next)||!clear(DECK_POINTS[node],DECK_POINTS[next],peers))continue;
      const cost=dist[node]+distance(DECK_POINTS[node],DECK_POINTS[next]);
      if(cost<dist[next]){dist[next]=cost;previous[next]=node;}
    }
  }
  if(!Number.isFinite(dist[to]))return [];
  const path=[to];while(path[0]!==from)path.unshift(previous[path[0]]);
  return path;
}
export function createDeckWalker(id,node) {
  return {id,node,x:DECK_POINTS[node][0],y:DECK_POINTS[node][1],goal:null,segment:null,next:null,
    moving:false,facing:1,pinned:false,paused:false,priority:0,order:0,blocked:0,coordinating:false,arrivals:0};
}
export const walkerBusy = walker => walker.goal!==null||walker.coordinating;
export function availableStop(walkers,walker,node) {
  return canStopDeckNode(node)&&walkers.every(peer=>peer===walker||
    (distance(DECK_POINTS[node],position(peer))>=MIN_SEPARATION&&
      (peer.goal===null||distance(DECK_POINTS[node],DECK_POINTS[peer.goal])>=MIN_SEPARATION)));
}
export function moveDeckWalker(walkers,walker,node) {
  if(!availableStop(walkers,walker,node))return false;
  walker.goal=node;walker.order=++requestOrder;walker.blocked=0;walker.coordinating=false;
  return true;
}
// 停止漫游时仍记住所在路段；后续指令只从该路段端点接路，不能斜穿障碍物。
export function stopDeckWalker(walker) {
  walker.goal=inPassage(walker)?passageExit(walker):null;walker.coordinating=false;walker.moving=false;walker.blocked=0;walker.order=++requestOrder;
}
export function settleDeckWalker(walker) {
  walker.coordinating=false;walker.goal=inPassage(walker)?passageExit(walker):(walker.segment?walker.next:walker.node);walker.order=++requestOrder;
}
function routeFrom(walker,goal,peers) {
  const starts=walker.segment?[walker.segment.from,walker.segment.to]:[walker.node];
  let result=[],best=Infinity;
  for(const start of starts){
    if(!clear(position(walker),DECK_POINTS[start],peers))continue;
    const path=deckRoute(start,goal,peers);if(!path.length)continue;
    const cost=distance(position(walker),DECK_POINTS[start])+path.slice(1).reduce((sum,node,i)=>sum+distance(DECK_POINTS[path[i]],DECK_POINTS[node]),0);
    if(cost<best){result=path;best=cost;}
  }
  return result;
}
export function meetingStop(walkers,walker,crew) {
  if(crew.segment||!canStopDeckNode(crew.node))return null;
  const choices=DECK_POINTS.map((point,node)=>({node,separation:distance(point,position(crew)),travel:distance(point,position(walker))}))
    .filter(item=>DECK_LEVELS[item.node]===DECK_LEVELS[crew.node]&&item.separation>=52&&item.separation<=145&&availableStop(walkers,walker,item.node))
    .sort((a,b)=>a.travel-b.travel);
  return choices.find(item=>routeFrom(walker,item.node,walkers.filter(peer=>peer!==walker&&(peer===crew||peer.pinned))).length)?.node??null;
}
const trafficPlans=new WeakMap();
const trafficSearches=new WeakMap();
const trafficAttempts=new WeakMap();
const planIdentity=walkers=>walkers.map(w=>`${w.order}:${w.goal}:${w.pinned}:${w.paused}`).join('|');
// ponytail: 仅为当前三名船员搜索有限的位置组合；新增大量角色时需换用专门的多主体寻路。
// 普通漫游保持并行。出现拥堵后才按无碰撞的路段顺序让路，避免优先级互相等待。
function* planTraffic(walkers) {
  const points=DECK_POINTS.map(point=>point),links=deckLinks.slice();
  const starts=walkers.map(walker=>{
    if(!walker.segment)return walker.node;
    const node=points.push(position(walker))-1;
    links[node]=[walker.segment.from,walker.segment.to];return node;
  });
  const encode=nodes=>nodes.reduce((key,node)=>key*points.length+node,0);
  const states=[starts],previous=[-1],via=[],seen=new Set([encode(starts)]);
  let deadline=performance.now()+4,expanded=0;
  for(let cursor=0;cursor<states.length;cursor++){
    // 三人各有 25 个节点和至多一个原路段位置，状态上限为 26³；跨帧续搜，不阻塞渲染。
    if(expanded>=1024||(expanded%64===0&&performance.now()>=deadline)){
      yield;deadline=performance.now()+4;expanded=0;
    }
    expanded++;
    const nodes=states[cursor];
    if(walkers.every((walker,i)=>walker.goal===null?(canStopDeckNode(nodes[i])||walker.pinned||walker.paused):nodes[i]===walker.goal)){
      const moves=[];for(let i=cursor;previous[i]!==-1;i=previous[i])moves.unshift(via[i]);
      return {moves,index:0,identity:planIdentity(walkers),moved:new Set()};
    }
    for(let actor=0;actor<walkers.length;actor++){
      const walker=walkers[actor];
      if((walker.paused&&(!inPassage(walker)||canStopDeckNode(nodes[actor])))||(walker.pinned&&(walker.goal===null||nodes[actor]===walker.goal)))continue;
      for(const next of links[nodes[actor]]){
        if(nodes.some((node,i)=>i!==actor&&segmentDistance(points[node],points[nodes[actor]],points[next])<MIN_SEPARATION-.001))continue;
        const state=nodes.slice();state[actor]=next;const key=encode(state);if(seen.has(key))continue;
        seen.add(key);states.push(state);previous.push(cursor);via[states.length-1]={actor,next};
      }
    }
  }
  return null;
}
function advanceTrafficSearch(walkers,search){
  const result=search.iterator.next();
  if(!result.done)return;
  trafficSearches.delete(walkers[0]);
  if(result.value)trafficPlans.set(walkers[0],result.value);
  else walkers.forEach(walker=>{walker.coordinating=false;walker.blocked=0;});
}
function advance(walker,walkers,delta,speed) {
  const target=DECK_POINTS[walker.next],from=position(walker),length=distance(from,target);
  const step=Math.min(length,Math.max(0,delta)*speed/1000),ratio=length?step/length:1;
  const to=[from[0]+(target[0]-from[0])*ratio,from[1]+(target[1]-from[1])*ratio];
  if(!clear(from,to,walkers.filter(peer=>peer!==walker))){walker.blocked+=delta;return false;}
  walker.blocked=0;walker.moving=length>.01;if(Math.abs(target[0]-from[0])>.1)walker.facing=target[0]<from[0]?1:-1;
  walker.x=to[0];walker.y=to[1];
  if(length>step+.001)return false;
  walker.node=walker.next;walker.next=null;walker.segment=null;return true;
}
export function stepDeckWalkers(walkers,delta,speed=54) {
  if(!walkers.length)return;
  walkers.forEach(walker=>{walker.moving=false;if(walker.goal===null&&!walker.coordinating&&inPassage(walker))walker.goal=passageExit(walker);});
  let plan=trafficPlans.get(walkers[0]);
  if(plan&&plan.identity!==planIdentity(walkers)){
    trafficPlans.delete(walkers[0]);walkers.forEach(walker=>{walker.coordinating=false;});plan=null;
  }
  const search=trafficSearches.get(walkers[0]);
  if(search){
    if(search.identity===planIdentity(walkers)){advanceTrafficSearch(walkers,search);return;}
    trafficSearches.delete(walkers[0]);walkers.forEach(walker=>{walker.coordinating=false;});
  }
  if(plan){
    const move=plan.moves[plan.index];
    if(move){
      const walker=walkers[move.actor];
      walker.segment??={from:walker.node,to:move.next};walker.next=move.next;
      if(advance(walker,walkers,delta,speed)){plan.index++;plan.moved.add(walker);}
    }
    if(plan.index===plan.moves.length){
      walkers.forEach(walker=>{if(walker.goal!==null||plan.moved.has(walker))walker.arrivals++;walker.goal=null;walker.coordinating=false;walker.blocked=0;});
      trafficPlans.delete(walkers[0]);trafficAttempts.delete(walkers[0]);
    }
    return;
  }
  const ordered=[...walkers].sort((a,b)=>b.priority-a.priority||a.order-b.order);
  for(const walker of ordered){
    if(walker.goal===null||(walker.paused&&!inPassage(walker)))continue;
    if(!walker.segment){
      if(walker.node===walker.goal){walker.goal=null;walker.arrivals++;continue;}
      const route=deckRoute(walker.node,walker.goal,walkers.filter(peer=>peer!==walker));
      if(route.length>1){walker.segment={from:walker.node,to:route[1]};walker.next=route[1];}
      else walker.blocked+=delta;
    }
    if(walker.segment&&advance(walker,walkers,delta,speed)&&walker.node===walker.goal){walker.goal=null;walker.arrivals++;}
    if(walker.blocked>=300){
      const identity=`${planIdentity(walkers)}:${walkers.map(peer=>`${peer.x},${peer.y}`).join('|')}`;
      if(trafficAttempts.get(walkers[0])!==identity){
        trafficAttempts.set(walkers[0],identity);
        const search={iterator:planTraffic(walkers),identity:planIdentity(walkers)};
        trafficSearches.set(walkers[0],search);
        walkers.forEach(peer=>{if(!peer.pinned&&!peer.paused)peer.coordinating=true;});
        advanceTrafficSearch(walkers,search);
        return;
      }
      walker.blocked=0;
    }
  }
}
