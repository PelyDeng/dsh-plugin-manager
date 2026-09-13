/**
 * 轨迹视图：设备组弹窗、抓拍/摄像头预览、二维与三维轨迹渲染。
 *
 * 页面模块（`type="module"`），由 app.js 在创建卡片层之后导入并创建：
 * `createTrajectoryView({ mapConfig, routePath, icons, el, escapeHtml, scrollBottom })`。
 * 自己写的辅助函数之间用模块内作用域，不再挂全局。
 */
import {vt, vh, fmtDT, groupDevCount, geoPoint, fencePoints} from './trajectory-data.js';
import {createCameraModal} from './trajectory-camera.js';

export function createTrajectoryView(options) {
    var MAP_CONFIG = options.mapConfig;
    var routePath = options.routePath;
    var IC = options.icons;
    var el = options.el;
    var esc = options.escapeHtml;
    var scrollBottom = options.scrollBottom;
    window.CESIUM_BASE_URL = routePath('/assets/cesium/');
    var DEVICE_GROUP_MARKER = routePath('/assets/cesium/device-group-marker.png');
    var trackData = {};
    var trackVehicles = {};
    var trackCams = {};
    var fenceData = {};
    var trackRenders = {};
    var snapshotQueue = Promise.resolve();
    var pendingDownloadUrls = [];

  // 点位取值（兼容 {lon,lat,h,t} 与 {longitude,latitude,height,pointTime}）

  var modal3dPreviousFocus = null;

  function trapModalFocus(event, overlay) {
    if (event.key !== 'Tab') return;
    var focusable = Array.from(overlay.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(function (node) { return node.offsetParent !== null; });
    if (!focusable.length) return;
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  var camera = createCameraModal({
    el: el,
    escapeHtml: esc,
    icons: IC,
    routePath: routePath,
    loadScript: loadScript,
    trapModalFocus: trapModalFocus,
  });

  var cesiumPromise = null;
  function loadCesium() {
    if (window.Cesium) return Promise.resolve(window.Cesium);
    if (!cesiumPromise) {
      cesiumPromise = loadScript(routePath('/assets/cesium/Cesium.js?v=1.142.0'))
        .then(function () {
          if (!window.Cesium) throw new Error('Cesium 资源未正确初始化');
          return window.Cesium;
        })
        .catch(function (error) { cesiumPromise = null; throw error; });
    }
    return cesiumPromise;
  }

  function mapStatus(container, text, failed, retry) {
    var old = container.querySelector('.map-status');
    if (old) old.remove();
    if (!text) return;
    var status = el('div', 'map-status' + (failed ? ' error' : ''));
    status.setAttribute('role', failed ? 'alert' : 'status');
    status.setAttribute('aria-live', failed ? 'assertive' : 'polite');
    status.appendChild(el('span', '', esc(text)));
    if (retry) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'track-3d-btn'; button.textContent = '重新加载三维地图';
      button.onclick = function () { button.disabled = true; container.setAttribute('aria-busy', 'true'); retry(); };
      status.appendChild(button);
    }
    container.appendChild(status);
  }

  function destroyMap(container) {
    if (container._readinessCleanup) container._readinessCleanup();
    container._readinessCleanup = null;
    if (container._snapshotCancel) container._snapshotCancel(new Error('轨迹截图已取消'));
    container._snapshotCancel = null;
    if (container._captureCancel) container._captureCancel(new Error('三维视图已离开当前页面'));
    container._captureCancel = null;
    if (container._captureUnlock) container._captureUnlock();
    container._captureUnlock = null;
    if (container._viewer && !container._viewer.isDestroyed()) container._viewer.destroy();
    container._viewer = null;
    container._tileset = null;
    container.dataset.mapReady = 'false';
    container.dataset.captureReady = 'false';
    container.dataset.snapshotReady = 'false';
    if (container._captureButton) container._captureButton.disabled = true;
    container.innerHTML = '';
  }

  function cancelMap(container) {
    container._generation = (container._generation || 0) + 1;
    destroyMap(container);
  }

  function setCaptureState(container, ready, message, failed) {
    container.dataset.captureReady = ready ? 'true' : 'false';
    if (container._captureButton) container._captureButton.disabled = !ready;
    if (container._captureStatus) {
      container._captureStatus.textContent = message || '';
      container._captureStatus.classList.toggle('error', Boolean(failed));
    }
  }

  function watchCaptureReadiness(container, viewer, tileset, generation) {
    var captureArmed = false;
    var frameHasTile = false;
    var settled = false;
    var stableTimer = null;
    function arm() {
      if (settled || captureArmed || container._generation !== generation) return;
      captureArmed = true;
      viewer.scene.requestRender();
    }
    function check() {
      if (settled || captureArmed || container._generation !== generation) return;
      if (tileset.tilesLoaded) arm();
      else if (!stableTimer) stableTimer = setTimeout(arm, 1000);
    }
    var removeTileVisible = tileset.tileVisible.addEventListener(function () { frameHasTile = true; });
    var removeAllLoaded = tileset.allTilesLoaded.addEventListener(check);
    var removePostRender = viewer.scene.postRender.addEventListener(function () {
      var currentFrameHasTile = frameHasTile;
      frameHasTile = false;
      if (settled || container._generation !== generation || !captureArmed || !currentFrameHasTile) return;
      settled = true;
      cleanup();
      setCaptureState(container, true, '三维模型已就绪，可截图并保存', false);
    });
    var timer = setTimeout(function () {
      if (settled || container._generation !== generation) return;
      setCaptureState(container, false, '三维模型仍在加载，暂不能截图', true);
    }, 15000);
    function cleanup() {
      removeTileVisible();
      removeAllLoaded();
      removePostRender();
      if (stableTimer) clearTimeout(stableTimer);
      clearTimeout(timer);
      if (container._readinessCleanup === cleanup) container._readinessCleanup = null;
    }
    container._readinessCleanup = cleanup;
    viewer.scene.requestRender();
    check();
  }

  function setTilesetHeight(tileset, heightMeters, Cesium) {
    var cartographic = Cesium.Cartographic.fromCartesian(tileset.boundingSphere.center);
    var surface = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 0);
    var offset = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, heightMeters);
    var translation = Cesium.Cartesian3.subtract(offset, surface, new Cesium.Cartesian3());
    // 3D Tiles 与地形的基准面可能不同；必须先按数据集校高，再进行相机取景。
    tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);
  }

  function waitForSnapshotView(viewer, tileset, container, generation, target, offset) {
    return new Promise(function (resolve, reject) {
      var attempt = 0;
      function run() {
        attempt++;
        var settled = false, flyResolved = false, captureArmed = false, captureFrameHasTile = false;
        var removeVisible, removeLoaded, removePost, settleTimer, timer;
        function cleanup() {
          if (removeVisible) removeVisible();
          if (removeLoaded) removeLoaded();
          if (removePost) removePost();
          if (settleTimer) clearTimeout(settleTimer);
          if (timer) clearTimeout(timer);
          if (container._snapshotCancel === cancel) container._snapshotCancel = null;
        }
        function cancel(error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        }
        function fail(error) {
          if (settled) return;
          settled = true;
          cleanup();
          if (attempt < 2 && container._generation === generation) {
            container.dataset.snapshotState = 'retrying';
            mapStatus(container, '三维模型尚未进入当前视角，正在重试…', false);
            run();
          } else reject(error);
        }
        function armCapture() {
          if (settled || captureArmed || !flyResolved) return;
          if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
          captureArmed = true;
          viewer.scene.requestRender();
        }
        function check() {
          if (settled || captureArmed || !flyResolved) return;
          if (tileset.tilesLoaded) return armCapture();
          if (!settleTimer) settleTimer = setTimeout(armCapture, 1000);
        }
        removeVisible = tileset.tileVisible.addEventListener(function () {
          if (container._generation === generation) captureFrameHasTile = true;
        });
        removeLoaded = tileset.allTilesLoaded.addEventListener(check);
        removePost = viewer.scene.postRender.addEventListener(function () {
          if (settled) return;
          var frameHasTile = captureFrameHasTile;
          captureFrameHasTile = false;
          if (!captureArmed || !frameHasTile) return;
          settled = true;
          cleanup();
          resolve();
        });
        container._snapshotCancel = cancel;
        timer = setTimeout(function () { fail(new Error('等待当前视角三维模型超时')); }, 7000);
        viewer.flyTo(target, { duration: 0, offset: offset }).then(function () {
          if (container._generation !== generation || viewer.isDestroyed()) return fail(new Error('轨迹截图已取消'));
          flyResolved = true;
          viewer.scene.requestRender();
          check();
        }).catch(fail);
      }
      run();
    });
  }

  function addMapContent(viewer, Cesium, pts, cams, callId, perspective) {
    var route = pts.map(geoPoint);
    var positions = route.map(function (p) { return Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h + 2); });
    viewer.entities.add({
      id: 'route-' + callId + '-' + perspective,
      polyline: { positions: positions, width: perspective ? 6 : 5, material: Cesium.Color.fromCssColorString('#3370ff'), depthFailMaterial: Cesium.Color.fromCssColorString('#8bb5ff') },
    });
    function endpoint(id, point, label, color) {
      viewer.entities.add({
        id: id + '-' + callId + '-' + perspective,
        position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat, point.h + 5),
        point: { pixelSize: 13, color: color, outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: label, font: 'bold 15px Microsoft YaHei', fillColor: color, outlineColor: Cesium.Color.WHITE, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -24), disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
    }
    if (route.length) {
      endpoint('start', route[0], '起点' + (route[0].t ? '\n' + route[0].t : ''), Cesium.Color.fromCssColorString('#22a06b'));
      endpoint('end', route[route.length - 1], '终点' + (route[route.length - 1].t ? '\n' + route[route.length - 1].t : ''), Cesium.Color.fromCssColorString('#ef4b56'));
    }
    var groupsByEntity = {};
    for (var i = 0; i < cams.length; i++) {
      var group = cams[i], point = geoPoint(group), entityId = 'device-group-' + callId + '-' + perspective + '-' + i;
      groupsByEntity[entityId] = group;
      viewer.entities.add({
        id: entityId,
        name: group.groupName || '设备组',
        position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat, point.h + 2),
        billboard: {
          image: DEVICE_GROUP_MARKER,
          width: perspective ? 58 : 48,
          height: perspective ? 113 : 94,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(400, 1.08, 15000, 0.62),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 25000),
        },
        label: {
          text: group.groupName || '设备组',
          font: perspective ? 'bold 15px Microsoft YaHei' : 'bold 13px Microsoft YaHei',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.fromCssColorString('#071d2b'),
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#0b324d').withAlpha(0.76),
          pixelOffset: new Cesium.Cartesian2(0, perspective ? -121 : -101),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(400, 1.05, 15000, 0.7),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 25000),
        },
      });
    }
    viewer.screenSpaceEventHandler.setInputAction(function (movement) {
      var picked = viewer.scene.pick(movement.position);
      var entity = picked && picked.id;
      var group = entity && groupsByEntity[entity.id];
      if (!group) return;
      camera.showGroup(group);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function addFenceContent(viewer, Cesium, fences, callId) {
    fences.forEach(function (fence, index) {
      var color = Cesium.Color.fromCssColorString(['#12b8c4', '#f59e0b', '#a855f7', '#3370ff'][index % 4]);
      var points = fence.positions.map(function (p) { return geoPoint({ lon: p[0], lat: p[1], h: p[2] }); });
      var positions = points.map(function (p) { return Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h); });
      var entity = {
        id: 'fence-' + callId + '-' + index,
        name: fence.name,
        position: Cesium.Cartesian3.fromDegrees(points[0].lon, points[0].lat, points[0].h + fence.height),
        label: { text: fence.name, font: 'bold 15px Microsoft YaHei', fillColor: color, outlineColor: Cesium.Color.BLACK, outlineWidth: 2, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -16), disableDepthTestDistance: Number.POSITIVE_INFINITY },
        polyline: { positions: fence.kind === 'polygon' ? positions.concat([positions[0]]) : positions, width: 3, material: color, depthFailMaterial: color.withAlpha(0.5) },
      };
      if (fence.kind === 'wall' && fence.height > 0) {
        entity.wall = {
          positions: positions,
          minimumHeights: points.map(function (p) { return p.h; }),
          maximumHeights: points.map(function (p) { return p.h + fence.height; }),
          material: color.withAlpha(0.45),
        };
      } else if (fence.kind === 'polygon') {
        entity.polygon = { hierarchy: new Cesium.PolygonHierarchy(positions), perPositionHeight: true, material: color.withAlpha(0.25) };
      }
      viewer.entities.add(entity);
    });
  }

  function renderFenceList(container, fences) {
    container.innerHTML = '';
    container.setAttribute('aria-label', '电子围栏');
    container.appendChild(el('div', 'legend-head', '<span class="legend-title">电子围栏</span><span class="legend-total">' + fences.length + '</span>'));
    fences.forEach(function (fence) {
      var item = el('div', 'track-group-item');
      item.textContent = fence.name + ' · ' + (fence.kind === 'wall' ? '围栏' : '区域') + ' · ' + fence.positions.length + ' 个边界点';
      container.appendChild(item);
    });
  }

  function mountMap(container, pts, cams, callId, perspective, snapshot, retrySnapshot, fences) {
    var generation = (container._generation || 0) + 1;
    container._generation = generation;
    destroyMap(container);
    mapStatus(container, '正在加载地形与三维模型…', false);
    container.dataset.mapReady = 'false';
    container.setAttribute('aria-busy', 'true');
    setCaptureState(container, false, snapshot ? '' : '正在加载三维模型…', false);
    if (snapshot) container.dataset.snapshotState = 'loading';
    return loadCesium().then(async function (Cesium) {
      var terrain = await Cesium.CesiumTerrainProvider.fromUrl(MAP_CONFIG.terrainUrl);
      if (container._generation !== generation) return;
      destroyMap(container);
      var viewer = new Cesium.Viewer(container, {
        terrainProvider: terrain,
        baseLayer: Cesium.ImageryLayer.fromProviderAsync(Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'))),
        contextOptions: { webgl: { preserveDrawingBuffer: true } },
        baseLayerPicker: false,
        geocoder: false,
        animation: false,
        timeline: false,
        selectionIndicator: false,
        infoBox: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        requestRenderMode: true,
        maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      });
      container._viewer = viewer;
      viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#d8e4d1');
      viewer.scene.globe.depthTestAgainstTerrain = true;
      var tileset = await Cesium.Cesium3DTileset.fromUrl(MAP_CONFIG.tilesetUrl, {
        maximumScreenSpaceError: 2,
      });
      if (container._generation !== generation) {
        if (tileset.destroy && (!tileset.isDestroyed || !tileset.isDestroyed())) tileset.destroy();
        if (!viewer.isDestroyed()) viewer.destroy();
        return;
      }
      viewer.scene.primitives.add(tileset);
      container._tileset = tileset;
      setTilesetHeight(tileset, MAP_CONFIG.tilesetHeight, Cesium);
      if (fences) addFenceContent(viewer, Cesium, fences, callId);
      else addMapContent(viewer, Cesium, pts, cams, callId, perspective);
      var trajectoryOffset = new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-55), 0);
      if (snapshot) await waitForSnapshotView(viewer, tileset, container, generation, viewer.entities, trajectoryOffset);
      else await viewer.flyTo(viewer.entities, { duration: 0, offset: trajectoryOffset });
      if (container._generation !== generation) return;
      if (snapshot) {
        if (viewer.isDestroyed() || !tileset.show || viewer.canvas.width === 0 || viewer.canvas.height === 0) throw new Error('三维场景尚未准备完成');
        var source = viewer.canvas.toDataURL('image/jpeg', 0.88);
        destroyMap(container);
        var image = document.createElement('img');
        image.className = 'track-snapshot';
        image.alt = fences ? '电子围栏三维场景截图' : '车辆轨迹三维场景截图';
        image.src = source;
        container.appendChild(image);
        container.dataset.snapshotReady = 'true';
        container.dataset.snapshotState = 'ready';
      }
      mapStatus(container, '', false);
      container.dataset.mapReady = snapshot ? 'false' : 'true';
      container.setAttribute('aria-busy', 'false');
      container.dataset.cesiumVersion = Cesium.VERSION;
      container.dataset.mapEngine = 'CesiumJS@1.142.0';
      container.dataset.tilesetHeight = String(MAP_CONFIG.tilesetHeight);
      container.dataset.deviceGroups = String(cams.length);
      if (!snapshot) watchCaptureReadiness(container, viewer, tileset, generation);
    }).catch(function (error) {
      if (container._generation !== generation) return;
      destroyMap(container);
      container.setAttribute('aria-busy', 'false');
      mapStatus(container, (snapshot ? '三维截图生成失败：' : '地图加载失败：') + (error && error.message ? error.message : String(error)), true, snapshot && retrySnapshot ? retrySnapshot : function () { mountMap(container, pts, cams, callId, perspective, snapshot, retrySnapshot, fences); });
      container.dataset.mapReady = 'false';
      if (snapshot) container.dataset.snapshotState = 'error';
      else setCaptureState(container, false, '三维地图加载失败，请重试', true);
    });
  }

  function waitForCaptureFrame(container, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var viewer = container._viewer;
      var tileset = container._tileset;
      var generation = container._generation;
      if (!viewer || viewer.isDestroyed() || !tileset || container.dataset.captureReady !== 'true') {
        reject(new Error('三维模型尚未就绪'));
        return;
      }
      setCaptureState(container, false, '正在等待当前视角的三维模型完成渲染…', false);
      var captureArmed = false;
      var frameHasTile = false;
      var done = false;
      var stableTimer = null;
      var cameraController = viewer.scene.screenSpaceCameraController;
      var inputsWereEnabled = cameraController.enableInputs;
      cameraController.enableInputs = false;
      function restoreInputs() {
        if (viewer.isDestroyed()) return;
        cameraController.enableInputs = inputsWereEnabled;
      }
      function arm() {
        if (done || captureArmed) return;
        captureArmed = true;
        viewer.scene.requestRender();
      }
      function check() {
        if (done || captureArmed) return;
        if (tileset.tilesLoaded) arm();
        else if (!stableTimer) stableTimer = setTimeout(arm, 1000);
      }
      var removeTileVisible = tileset.tileVisible.addEventListener(function () { frameHasTile = true; });
      var removeAllLoaded = tileset.allTilesLoaded.addEventListener(check);
      var removePostRender = viewer.scene.postRender.addEventListener(function () {
        var currentFrameHasTile = frameHasTile;
        frameHasTile = false;
        if (!captureArmed || !currentFrameHasTile) return;
        finish(null, viewer.canvas);
      });
      var timer = setTimeout(function () {
        finish(new Error('当前视角的三维模型尚未加载完成'));
      }, timeoutMs);
      function finish(error, canvas) {
        if (done) return;
        done = true;
        removeTileVisible();
        removeAllLoaded();
        removePostRender();
        if (stableTimer) clearTimeout(stableTimer);
        clearTimeout(timer);
        if (container._captureCancel === cancel) container._captureCancel = null;
        if (error) {
          restoreInputs();
          reject(error);
        } else {
          container._captureUnlock = function () {
            restoreInputs();
            if (container._captureUnlock) container._captureUnlock = null;
          };
          resolve(canvas);
        }
      }
      function cancel(error) { finish(error || new Error('当前视角截图已取消')); }
      container._captureCancel = cancel;
      viewer.scene.requestRender();
      check();
    });
  }

  function releaseDownloadUrl(url) {
    var index = pendingDownloadUrls.indexOf(url);
    if (index >= 0) pendingDownloadUrls.splice(index, 1);
    URL.revokeObjectURL(url);
  }

  function captureTrajectoryMap(container, callId, button) {
    var generation = container._generation;
    var viewer = container._viewer;
    button.disabled = true;
    button.textContent = '正在准备当前视角…';
    waitForCaptureFrame(container, 10000).then(function (canvas) {
      if (container._generation !== generation || container._viewer !== viewer) throw new Error('三维视图已更新，请重新截图');
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (container._generation !== generation || container._viewer !== viewer) reject(new Error('三维视图已更新，请重新截图'));
          else if (blob) resolve(blob);
          else reject(new Error('浏览器未能生成 PNG'));
        }, 'image/png');
      });
    }).then(function (blob) {
      if (container._generation !== generation || container._viewer !== viewer) throw new Error('三维视图已更新，请重新截图');
      var url = URL.createObjectURL(blob);
      pendingDownloadUrls.push(url);
      setTimeout(function () { releaseDownloadUrl(url); }, 60000);
      var link = document.createElement('a');
      try {
        link.href = url;
        link.download = (fenceData[callId] ? '电子围栏-' : '车辆轨迹-') + callId + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
        link.hidden = true;
        link.tabIndex = -1;
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
      }
      setCaptureState(container, true, '截图已开始保存到本机，三维视图保持不变', false);
    }).catch(function (error) {
      if (container._generation === generation && container._viewer === viewer) {
        setCaptureState(container, true, '截图失败：' + (error && error.message ? error.message : String(error)), true);
      }
    }).finally(function () {
      if (container._captureUnlock) container._captureUnlock();
      if (container._generation === generation && container._viewer === viewer) {
        button.disabled = container.dataset.captureReady !== 'true';
        button.innerHTML = IC.camera + ' 截图并保存';
      }
    });
  }

  // 回答区自动生成静态三维截图；交互和手动保存只在大屏弹窗中提供。
  function renderTrajectory(cacheKey, callId, bubble) {
    var pts = trackData[cacheKey];
    if (!pts || !pts.length) return null;
    var fences = fenceData[cacheKey];
    var vehicleNo = trackVehicles[cacheKey] || '车牌未知';
    var timeRange = fmtDT(vt(pts[0])) + ' 至 ' + fmtDT(vt(pts[pts.length - 1]));
    var trackLabel = fences ? '电子围栏 · ' + fences.length + ' 个边界' : vehicleNo + ' · 车辆轨迹 ' + timeRange;
    var map = el('div', 'track-map');
    map.setAttribute('role', 'region');
    map.setAttribute('aria-label', trackLabel + '三维场景截图');
    var cams = trackCams[cacheKey] || [];
    var section = el('section', 'trajectory-result result-source');
    var sectionTitle = el('h4', 'trajectory-title');
    if (fences) sectionTitle.textContent = trackLabel;
    else {
      var plate = el('strong', 'trajectory-plate');
      plate.textContent = vehicleNo;
      sectionTitle.appendChild(plate);
      var detail = el('span', 'trajectory-time');
      detail.textContent = '车辆轨迹 · ' + timeRange;
      sectionTitle.appendChild(detail);
    }
    sectionTitle.id = 'trajectory-' + cacheKey.replace(/[^a-zA-Z0-9_-]/g, '-');
    section.setAttribute('aria-labelledby', sectionTitle.id);
    var box = el('div', 'track-fig');
    var legendEl = el('div', 'track-legend');
    legendEl.setAttribute('aria-label', '轨迹设备组');
    var stage = el('div', 'track-stage');
    stage.appendChild(map);
    stage.appendChild(legendEl);
    box.appendChild(stage);
    var capEl = el('div', 'cap');
    box.appendChild(capEl);
    var actions = el('div', 'track-actions');
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'track-3d-btn';
    btn.innerHTML = IC.locate + ' 全屏查看';
    btn.setAttribute('aria-label', '全屏查看' + trackLabel);
    btn.onclick = function () { open3DView(pts, trackCams[cacheKey] || [], cacheKey, fences); };
    actions.appendChild(btn);
    section.appendChild(sectionTitle);
    section.appendChild(actions);
    section.appendChild(box);
    bubble.appendChild(section);
    trackRenders[cacheKey] = { map: map, pts: pts, cap: capEl, legend: legendEl, snapshotToken: 0, fences: fences };
    redrawTrack(cacheKey);
    scrollBottom();
    return section;
  }

  function queueTrajectorySnapshot(render, cams, callId) {
    var token = ++render.snapshotToken;
    cancelMap(render.map);
    render.map.dataset.snapshotState = 'queued';
    render.map.setAttribute('aria-busy', 'true');
    mapStatus(render.map, '正在等待生成三维场景截图…', false);
    function runSnapshot() {
      if (render.snapshotToken !== token || !render.map.isConnected) return;
      return mountMap(render.map, render.pts, cams, callId, false, true, function () {
        queueTrajectorySnapshot(render, cams, callId);
      }, render.fences);
    }
    snapshotQueue = snapshotQueue.then(runSnapshot, runSnapshot);
  }

  function redrawTrack(cacheKey) {
    var r = trackRenders[cacheKey];
    if (!r) return;
    var cams = trackCams[cacheKey] || [];
    queueTrajectorySnapshot(r, cams, cacheKey);
    if (r.fences) {
      r.cap.textContent = '电子围栏（三维场景截图） · ' + r.fences.length + ' 个边界 · 按保存的边界坐标与围栏高度展示';
      renderFenceList(r.legend, r.fences);
      return;
    }
    if (r.cap) {
      var dc = groupDevCount(cams);
      r.cap.textContent = '轨迹示意图（三维场景截图） · ' + r.pts.length + ' 个点位' + (cams.length ? (' · 轨迹 ' + MAP_CONFIG.trackDeviceRadiusMeters + ' 米内设备组 ' + cams.length + ' 个' + (dc ? (' · 设备 ' + dc + ' 个') : '') + ' · 点击侧栏名称查看摄像头') : '') + ' · ' + fmtDT(vt(r.pts[0])) + ' ~ ' + fmtDT(vt(r.pts[r.pts.length - 1]));
    }
    if (r.legend) {
      camera.renderGroupList(r.legend, cams);
    }
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // 三维轨迹：真实地形、3D Tiles、轨迹点和设备组共用同一个 Cesium 数据模型。
  function open3DView(pts, cams, callId, fences) {
    var overlay = document.getElementById('modal3d');
    var container = document.getElementById('modal3dCanvas');
    var legend = document.getElementById('modal3dLegend');
    var title = document.getElementById('modal3dTitle');
    var foot = document.getElementById('modal3dFoot');
    var modalCapture = document.getElementById('modal3dCapture');
    var captureStatus = document.getElementById('modal3dCaptureStatus');
    if (!overlay || !container || !modalCapture || !captureStatus) return;
    modal3dPreviousFocus = document.activeElement;
    var heights = pts.map(vh);
    var minH = Math.min.apply(null, heights), maxH = Math.max.apply(null, heights);
    var devs = groupDevCount(cams || []);
    title.textContent = '三维轨迹 · ' + pts.length + ' 点 · ' + fmtDT(vt(pts[0])) + ' ~ ' + fmtDT(vt(pts[pts.length - 1]));
    if (!fences) {
      var plate = el('strong', 'trajectory-plate');
      plate.textContent = trackVehicles[callId] || '车牌未知';
      title.prepend(plate, document.createTextNode(' '));
    }
    foot.textContent = '真实地形与三维模型 · 海拔 ' + Math.round(minH) + ' ~ ' + Math.round(maxH) + ' 米' + ((cams && cams.length) ? (' · 设备组 ' + cams.length + ' 个 · 设备 ' + devs + ' 个') : '') + '；点击设备组可查看组内摄像头。';
    if (fences) {
      title.textContent = '三维电子围栏 · ' + fences.length + ' 个边界';
      foot.textContent = '真实地形与三维模型 · 按保存的边界坐标与围栏高度展示';
    }
    modalCapture.innerHTML = IC.camera + ' 截图并保存';
    modalCapture.setAttribute('aria-label', '截取并保存当前全屏三维视角');
    document.getElementById('modal3dClose').setAttribute('aria-label', '关闭' + (fences ? '三维电子围栏' : '三维轨迹'));
    modalCapture.disabled = true;
    modalCapture.onclick = function () { captureTrajectoryMap(container, callId, modalCapture); };
    container._captureButton = modalCapture;
    container._captureStatus = captureStatus;
    overlay.style.display = 'flex';
    if (fences) renderFenceList(legend, fences);
    else camera.renderGroupList(legend, cams || []);
    mountMap(container, pts, cams || [], callId, true, false, undefined, fences);

    function close() {
      overlay.style.display = 'none';
      cancelMap(container);
      camera.close();
      if (modal3dPreviousFocus && modal3dPreviousFocus.focus) modal3dPreviousFocus.focus({ preventScroll: true });
    }
    document.getElementById('modal3dClose').onclick = close;
    overlay.onclick = function (event) { if (event.target === overlay) close(); };
    overlay.onkeydown = function (event) {
      if (event.key === 'Escape') { close(); return; }
      trapModalFocus(event, overlay);
    };
    document.getElementById('modal3dClose').focus({ preventScroll: true });
  }

    function renderFences(cacheKey, callId, payload, bubble) {
      var section;
      if (payload.geometries.length) {
        fenceData[cacheKey] = payload.geometries;
        trackData[cacheKey] = fencePoints(payload.geometries);
        section = renderTrajectory(cacheKey, callId, bubble);
      } else {
        section = el('section', 'trajectory-result result-source');
        bubble.appendChild(section);
      }
      if (payload.note) {
        var note = el('p', 'cap');
        note.setAttribute('role', 'status');
        note.textContent = payload.note;
        section.appendChild(note);
      }
      return section;
    }

    function setTrack(cacheKey, points, vehicleNo) {
      trackData[cacheKey] = points;
      trackVehicles[cacheKey] = vehicleNo;
    }

    function setCameras(cacheKey, cameras) {
      trackCams[cacheKey] = cameras;
      redrawTrack(cacheKey);
    }

    function reset() {
      camera.close();
      var modal = document.getElementById('modal3d');
      if (modal) modal.style.display = 'none';
      var modalMap = document.getElementById('modal3dCanvas');
      if (modalMap) cancelMap(modalMap);
      for (var cacheKey in trackRenders) {
        if (trackRenders[cacheKey] && trackRenders[cacheKey].map) cancelMap(trackRenders[cacheKey].map);
      }
      trackData = {};
      trackVehicles = {};
      trackCams = {};
      fenceData = {};
      trackRenders = {};
      snapshotQueue = Promise.resolve();
      dispose();
    }

    function dispose() {
      pendingDownloadUrls.splice(0).forEach(function (url) { URL.revokeObjectURL(url); });
    }

    return {
      dispose: dispose,
      render: renderTrajectory,
      renderFences: renderFences,
      reset: reset,
      setCameras: setCameras,
      setTrack: setTrack,
      showGroup: camera.showGroup,
    };
  }
