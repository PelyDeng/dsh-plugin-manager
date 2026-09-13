/**
 * 轨迹视图的纯函数：点位字段别名、时间格式化、坐标换算、设备组统计、围栏点位。
 *
 * 不碰 DOM 也不碰 Cesium，因此能在 node 下直接测（`tests/trajectory-data.test.ts`）。
 * 点位字段两套写法（`{lon,lat,h,t}` 与 `{longitude,latitude,height,pointTime}`）在这里收敛成一处。
 */

export function vlon(p) { return p.lon !== undefined ? +p.lon : +p.longitude; }

export function vlat(p) { return p.lat !== undefined ? +p.lat : +p.latitude; }

export function vh(p) { return p.h !== undefined ? +p.h : (+p.height || 0); }

export function vt(p) { return p.t !== undefined ? p.t : p.pointTime; }

export function fmtDT(v) {
  if (!v) return '';
  var n = typeof v === 'number' ? v : (+v);
  if (!isNaN(n) && n > 1e11) { var d = new Date(n); function p(x){return (x<10?'0':'')+x} return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }
  return String(v);
}

export function groupDevCount(cams) { var n = 0; for (var i = 0; i < cams.length; i++) n += (cams[i].devices ? cams[i].devices.length : 0); return n; }

export function camerasFor(group) { return (group.devices || []).filter(function (device) { return Number(device.deviceType) === 6; }); }

export function cameraOnline(camera) { return Number(camera.status) === 1; }

export function cameraName(camera) { return camera.name || camera.code || camera.cameraCode || '未命名摄像头'; }

export function degree(value, latitude) {
  var limit = latitude ? Math.PI / 2 + 0.01 : Math.PI + 0.01;
  return Math.abs(value) <= limit ? value * 180 / Math.PI : value;
}

export function geoPoint(p) {
  return { lon: degree(vlon(p), false), lat: degree(vlat(p), true), h: vh(p), t: fmtDT(vt(p)) };
}

/** 围栏标绘：每段几何的 positions 拍平成点位数组。 */
export function fencePoints(geometries) {
  return (geometries || []).flatMap(function (fence) {
    return fence.positions.map(function (p) { return { lon: p[0], lat: p[1], h: p[2] }; });
  });
}
