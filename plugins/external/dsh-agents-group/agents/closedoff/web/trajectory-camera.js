/**
 * 摄像头与设备组弹窗：设备组列表、摄像头选择、抓拍片段预览与信息行。
 *
 * 纯 DOM，不需要 Cesium；弹窗标记在 index.html 里，本模块在创建时接上它的处理器。
 * 由 trajectory.js 传入它需要的外部件：`el`／`escapeHtml`／`icons`／`routePath`／
 * `loadScript`（播放器按需加载）／`trapModalFocus`（两个弹窗共用的焦点陷阱）。
 */
import {cameraName, cameraOnline, camerasFor, fmtDT} from './trajectory-data.js';

export function createCameraModal(seam) {
  var el = seam.el;
  var esc = seam.escapeHtml;
  var icons = seam.icons;
  var routePath = seam.routePath;
  var loadScript = seam.loadScript;
  var trapModalFocus = seam.trapModalFocus;

  var cameraModalPreviousFocus = null;
  var cameraModalGroup = null;
  var cameraModalCameras = [];
  var cameraModalSelected = null;
  var cameraPlayerPromise = null;
  var cameraPlayerPrewarmScheduled = false;
  var cameraPlayerApp = null;
  var cameraPlayerRenderId = 0;

  function destroyCameraPlayer() {
    cameraPlayerRenderId += 1;
    if (cameraPlayerApp) {
      cameraPlayerApp.unmount();
      cameraPlayerApp = null;
    }
  }

  function loadCameraPlayer() {
    if (window.Vue && window.hyVideoPlayer && window.JessibucaPro) return Promise.resolve();
    if (!cameraPlayerPromise) {
      cameraPlayerPromise = loadScript(routePath('/assets/video-player/vue.global.prod.js?v=3.5.42'))
        .then(function () { return loadScript(routePath('/assets/video-player/plugin/jessibuca/jessibuca-pro.js?v=0.0.37')); })
        .then(function () { return loadScript(routePath('/assets/video-player/index.umd.cjs?v=0.0.37')); })
        .then(function () {
          if (!window.Vue || !window.hyVideoPlayer || !window.JessibucaPro) throw new Error('定制播放器资源未正确初始化');
        })
        .catch(function (error) { cameraPlayerPromise = null; throw error; });
    }
    return cameraPlayerPromise;
  }

  function scheduleCameraPlayerPrewarm(cams) {
    if (cameraPlayerPrewarmScheduled) return;
    var hasPlayableCamera = cams.some(function (group) {
      return camerasFor(group).some(function (camera) {
        return Boolean(camera.accessAddress || camera.videoAddress);
      });
    });
    if (!hasPlayableCamera) return;
    cameraPlayerPrewarmScheduled = true;
    var run = function () { loadCameraPlayer().catch(function () {}); };
    if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 2000 });
    else window.setTimeout(run, 600);
  }

  function closeCameraModal() {
    var overlay = document.getElementById('cameraModal');
    if (!overlay || overlay.style.display === 'none') return;
    overlay.style.display = 'none';
    destroyCameraPlayer();
    if (cameraModalPreviousFocus && cameraModalPreviousFocus.focus) cameraModalPreviousFocus.focus({ preventScroll: true });
  }

  function renderCameraInfo(camera) {
    var info = document.getElementById('cameraInfo');
    info.innerHTML = '';
    var rows = camera.capture ? [
      ['抓拍开始', camera.startTime || '--'],
      ['片段时长', camera.timeLength || '--'],
      ['设备编号', camera.deviceId || '--'],
      ['媒体地址', '已隐藏'],
    ] : [
      ['设备编码', camera.code || '--'],
      ['摄像机编码', camera.cameraCode || '--'],
      ['设备 IP', camera.deviceIp || '--'],
      ['视频地址', camera.hideAddress ? '已隐藏' : (camera.accessAddress || camera.videoAddress || '--')],
      ['所属设备组', cameraModalGroup.groupName || '--'],
      ['最后心跳', fmtDT(camera.lastHeartbeatTime) || '--'],
      ['运行状态', cameraOnline(camera) ? '在线' : '离线'],
    ];
    rows.forEach(function (row, index) {
      var wrap = el('div', 'camera-info-row');
      var dt = document.createElement('dt'); dt.textContent = row[0];
      var dd = document.createElement('dd'); dd.textContent = row[1];
      if (!camera.capture && index === rows.length - 1 && cameraOnline(camera)) dd.className = 'ok';
      wrap.appendChild(dt); wrap.appendChild(dd); info.appendChild(wrap);
    });
  }

  function renderCameraPreview(camera) {
    var preview = document.getElementById('cameraPreview');
    destroyCameraPlayer();
    preview.innerHTML = '';
    var stream = camera.accessAddress || camera.videoAddress || '';
    var state = el('div', 'camera-preview-state');
    var title = el('div', 'camera-preview-title'); title.textContent = cameraName(camera);
    var copy = el('div', 'camera-preview-copy');
    copy.textContent = camera.capture
      ? (stream ? '正在加载抓拍视频…' : '当前抓拍片段未返回可用的视频地址。')
      : (stream ? '正在加载园区定制播放器…' : '当前摄像头未返回可用的视频地址。');
    state.appendChild(title); state.appendChild(copy); preview.appendChild(state);
    if (!stream) return;
    var renderId = cameraPlayerRenderId;
    loadCameraPlayer().then(function () {
      if (renderId !== cameraPlayerRenderId || camera !== cameraModalSelected) return;
      preview.innerHTML = '';
      var host = document.createElement('div');
      host.className = 'camera-player-host';
      preview.appendChild(host);
      cameraPlayerApp = window.Vue.createApp({
        render: function () {
          return window.Vue.h(window.hyVideoPlayer.hyVideoPlayer, {
            url: stream,
            autoPlay: true,
            isAi: true,
            controlAutoHide: true,
            resUrl: routePath('/assets/video-player/plugin/jessibuca'),
            configOperates: { ai: true, ptz: false, close: false, fullscreen: true, screenshot: true, record: false, zoom: true },
          });
        },
      });
      cameraPlayerApp.provide('hyPlayerGconfig', {
        isDev: false,
        resUrl: routePath('/assets/video-player/plugin/jessibuca'),
        isAi: false,
      });
      cameraPlayerApp.mount(host);
    }).catch(function (error) {
      if (renderId !== cameraPlayerRenderId || camera !== cameraModalSelected) return;
      preview.innerHTML = '';
      var failed = el('div', 'camera-preview-state');
      failed.appendChild(el('div', 'camera-preview-title', esc(cameraName(camera))));
      failed.appendChild(el('div', 'camera-preview-copy', '定制播放器加载失败，请检查本地播放器资源。'));
      preview.appendChild(failed);
      console.error('camera player load failed', error);
    });
  }

  function selectCamera(camera) {
    cameraModalSelected = camera;
    document.getElementById('cameraSelectedName').textContent = camera.capture ? '抓拍片段' : '摄像头 - ' + cameraName(camera);
    var status = document.getElementById('cameraSelectedStatus');
    status.className = 'camera-online' + (cameraOnline(camera) ? ' ok' : '');
    status.textContent = camera.capture ? '' : (cameraOnline(camera) ? '● 在线' : '● 离线');
    renderCameraPreview(camera); renderCameraInfo(camera);
    if (!camera.capture) renderCameraChoices();
  }

  function cameraChoice(camera, className) {
    var button = document.createElement('button');
    button.type = 'button'; button.className = className + (camera === cameraModalSelected ? ' active' : ''); button._camera = camera;
    if (camera === cameraModalSelected) button.setAttribute('aria-current', 'true');
    var dot = el('span', 'camera-status-dot' + (cameraOnline(camera) ? ' online' : ''));
    if (className === 'camera-list-item') {
      button.appendChild(dot); button.appendChild(el('span', 'camera-item-name', esc(cameraName(camera))));
    } else {
      button.appendChild(el('span', 'camera-thumb-name', esc(cameraName(camera))));
      var status = el('span', 'camera-thumb-status'); status.appendChild(dot); status.appendChild(document.createTextNode(cameraOnline(camera) ? '在线' : '离线')); button.appendChild(status);
    }
    button.onclick = function () { selectCamera(this._camera); };
    return button;
  }

  function renderCameraChoices() {
    var query = document.getElementById('cameraSearch').value.trim().toLowerCase();
    var visible = cameraModalCameras.filter(function (camera) { return (cameraName(camera) + ' ' + (camera.code || '') + ' ' + (camera.cameraCode || '')).toLowerCase().indexOf(query) >= 0; });
    var list = document.getElementById('cameraList'); list.innerHTML = '';
    if (!visible.length) list.appendChild(el('div', 'camera-list-empty', '没有匹配的摄像头'));
    visible.forEach(function (camera) { list.appendChild(cameraChoice(camera, 'camera-list-item')); });
    var strip = document.getElementById('cameraStrip'); strip.innerHTML = '';
    cameraModalCameras.forEach(function (camera) { strip.appendChild(cameraChoice(camera, 'camera-thumb')); });
  }

  function showGroupPopup(group) {
    var overlay = document.getElementById('cameraModal');
    cameraModalPreviousFocus = document.activeElement;
    cameraModalGroup = group;
    cameraModalCameras = camerasFor(group);
    cameraModalSelected = cameraModalCameras[0] || null;
    overlay.classList.toggle('capture-mode', Boolean(group.captureMode));
    document.getElementById('cameraModalTitle').textContent = group.captureMode ? '车辆抓拍视频' : (group.groupName || '设备组') + ' 的摄像头';
    var online = cameraModalCameras.filter(cameraOnline).length;
    document.getElementById('cameraStats').innerHTML = group.captureMode ? '' : '<span>摄像头 <strong>' + cameraModalCameras.length + '</strong></span><span class="online">在线 <strong>' + online + '</strong></span>';
    var search = document.getElementById('cameraSearch'); search.value = ''; search.oninput = renderCameraChoices;
    overlay.style.display = 'flex';
    if (cameraModalSelected) selectCamera(cameraModalSelected);
    else {
      document.getElementById('cameraList').innerHTML = '<div class="camera-list-empty">该设备组下没有摄像头</div>';
      document.getElementById('cameraStrip').innerHTML = '';
      document.getElementById('cameraSelectedName').textContent = '暂无摄像头';
      document.getElementById('cameraSelectedStatus').textContent = '';
      document.getElementById('cameraPreview').innerHTML = '<div class="camera-preview-state"><div class="camera-preview-title">暂无摄像头</div><div class="camera-preview-copy">该设备组只包含其他类型设备，本弹窗按要求不予展示。</div></div>';
      document.getElementById('cameraInfo').innerHTML = '';
    }
    document.getElementById('cameraModalClose').focus({ preventScroll: true });
  }

  function renderGroupList(container, cams) {
    if (!container) return;
    container.innerHTML = '';
    var head = el('div', 'legend-head');
    head.appendChild(el('div', 'legend-title', icons.camera + ' 设备组 <small>点击查看摄像头</small>'));
    head.appendChild(el('span', 'legend-total', String(cams.length)));
    container.appendChild(head);
    if (!cams.length) { container.appendChild(el('div', 'legend-empty', '正在等待设备组标绘数据…')); return; }
    scheduleCameraPlayerPrewarm(cams);
    var list = el('div', 'legend-list');
    for (var i = 0; i < cams.length; i++) {
      var group = cams[i];
      var item = document.createElement('button');
      item.type = 'button'; item.className = 'lg-item'; item._group = group;
      item.title = '查看 ' + (group.groupName || '设备组') + ' 的摄像头';
      item.appendChild(el('span', 'lg-no', String(i + 1).padStart(2, '0')));
      item.appendChild(el('span', 'lg-name', esc(group.groupName || '设备组')));
      item.appendChild(el('span', 'lg-count', camerasFor(group).length + ' 路'));
      item.onclick = function () { showGroupPopup(this._group); };
      list.appendChild(item);
    }
    container.appendChild(list);
  }

  document.getElementById('cameraModalClose').onclick = closeCameraModal;
  document.getElementById('cameraModal').onclick = function (event) { if (event.target === this) closeCameraModal(); };
  document.getElementById('cameraModal').onkeydown = function (event) {
    if (event.key === 'Escape') { event.stopPropagation(); closeCameraModal(); return; }
    trapModalFocus(event, this);
  };

  return { close: closeCameraModal, showGroup: showGroupPopup, renderGroupList: renderGroupList };
}
