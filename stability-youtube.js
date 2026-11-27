/* Stability, seeking and URL intake for ClipForge.
   YouTube playback is embedded legally; the browser cannot extract its media stream.
   Actual editing still requires a local video file or a direct CORS-enabled media URL. */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const video = vid;
  const originalSeek = seek;

  // A seek timeout must not be treated as success: doing so exports stale frames.
  seek = async function(time) {
    if (!video || !Number.isFinite(time)) throw new Error('Tiempo de vídeo no válido.');
    if (video.readyState < 1) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('El vídeo no ha cargado sus metadatos.')); }, 15000);
        const ready = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('No se pudo leer el vídeo.')); };
        const cleanup = () => {
          clearTimeout(timer);
          video.removeEventListener('loadedmetadata', ready);
          video.removeEventListener('error', failed);
        };
        video.addEventListener('loadedmetadata', ready, { once: true });
        video.addEventListener('error', failed, { once: true });
      });
    }
    const target = Math.max(0, Math.min(time, Math.max(0, (video.duration || time) - 0.04)));
    if (Math.abs(video.currentTime - target) < 0.015 && video.readyState >= 2) {
      if (video.requestVideoFrameCallback) {
        await new Promise(resolve => video.requestVideoFrameCallback(() => resolve()));
      }
      return;
    }
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('seeked', done);
        video.removeEventListener('error', failed);
      };
      const done = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Error al posicionar el vídeo. Prueba a volver a cargarlo.')); };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('El vídeo tardó demasiado en buscar ese fotograma. Prueba con MP4 H.264 o divide el archivo.'));
      }, 12000);
      video.addEventListener('seeked', done, { once: true });
      video.addEventListener('error', failed, { once: true });
      video.currentTime = target;
    });
    if (video.requestVideoFrameCallback) {
      await new Promise(resolve => video.requestVideoFrameCallback(() => resolve()));
    }
  };

  // Reset old media and clip state when the source changes.
  const oldLoad = load;
  load = function(file) {
    if (!file) return;
    if (!file.type.startsWith('video/') && !file.type.startsWith('audio/')) {
      log('Formato no compatible. Elige un vídeo MP4, MOV o WebM.');
      return;
    }
    if (S.objectUrl) URL.revokeObjectURL(S.objectUrl);
    S.clips = [];
    S.cur = null;
    S.words = [];
    S.sents = [];
    $('#clips').innerHTML = '<p class="empty">Vídeo nuevo cargado. Pulsa «Buscar clips virales».</p>';
    $('#expall').disabled = true;
    $('#play').disabled = true;
    $('#exp').disabled = true;
    oldLoad(file);
    const previousUrl = video.src;
    S.objectUrl = URL.createObjectURL(file);
    video.src = S.objectUrl;
    if (previousUrl && previousUrl.startsWith('blob:')) URL.revokeObjectURL(previousUrl);
    video.onerror = () => log('No se pudo decodificar este archivo. Prueba MP4 con vídeo H.264 y audio AAC.');
  };

  // URL input: direct media links are fetched only if the host permits CORS.
  // YouTube URLs get an official embed preview, never a fake "download" flow.
  const panel = document.createElement('div');
  panel.style.cssText = 'margin:0 0 12px;padding:12px;border:1.5px solid var(--line);border-radius:6px;background:#fafbfe';
  panel.innerHTML = '<label class="f" style="font-size:13px;color:var(--ink);font-weight:700">O pega un enlace de vídeo</label><div style="display:flex;gap:8px;margin-top:6px"><input id="video-url" type="url" placeholder="https://youtu.be/... o enlace directo .mp4" style="min-width:0;flex:1;font:inherit;padding:8px;border:1.5px solid var(--line);border-radius:4px"><button id="load-url" type="button">Abrir enlace</button></div><div id="url-note" role="status" style="font-size:12px;color:var(--mut);margin-top:7px">Los enlaces directos necesitan permisos CORS. YouTube se puede previsualizar, pero para generar clips tendrás que cargar un archivo de vídeo que tengas derecho a utilizar.</div><div id="yt-preview" style="display:none;margin-top:10px;aspect-ratio:16/9;background:#000;border-radius:6px;overflow:hidden"></div>';
  $('#drop').after(panel);
  const note = $('#url-note');
  const getYoutubeId = raw => {
    try {
      const u = new URL(raw);
      if (u.hostname === 'youtu.be' || u.hostname.endsWith('.youtu.be')) return u.pathname.split('/').filter(Boolean)[0] || '';
      if (u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com') || u.hostname === 'm.youtube.com') {
        if (u.pathname === '/watch') return u.searchParams.get('v') || '';
        const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
        return m ? m[1] : '';
      }
    } catch {}
    return '';
  };
  $('#load-url').onclick = async () => {
    const raw = $('#video-url').value.trim();
    if (!raw) { note.textContent = 'Pega primero un enlace.'; return; }
    let url;
    try { url = new URL(raw); } catch { note.textContent = 'El enlace no es válido.'; return; }
    if (!['https:', 'http:'].includes(url.protocol)) { note.textContent = 'Solo se admiten enlaces HTTP o HTTPS.'; return; }
    const id = getYoutubeId(raw);
    const preview = $('#yt-preview');
    preview.replaceChildren();
    if (id && /^[\w-]{11}$/.test(id)) {
      const frame = document.createElement('iframe');
      frame.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id);
      frame.title = 'Vista previa de YouTube';
      frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      frame.allowFullscreen = true;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.style.cssText = 'width:100%;height:100%;border:0';
      preview.append(frame);
      preview.style.display = 'block';
      note.textContent = 'Vista previa de YouTube cargada. YouTube no expone el archivo de vídeo al editor externo, así que no podemos analizar ni exportar clips desde esta URL. Si tienes permiso para usar el vídeo, carga aquí su archivo original.';
      return;
    }
    if (!/\.(mp4|webm|mov|m4v|ogv)(?:$|[?#])/i.test(url.pathname + url.search)) {
      note.textContent = 'No parece un enlace directo a un archivo de vídeo. Para YouTube se muestra una vista previa, pero el montaje necesita el archivo original.';
      return;
    }
    const button = $('#load-url');
    button.disabled = true;
    note.textContent = 'Descargando el archivo desde el enlace… el servidor debe permitir CORS. Para vídeos muy grandes, es mejor elegir el archivo desde el dispositivo.';
    try {
      const response = await fetch(url.href, { mode: 'cors' });
      if (!response.ok) throw new Error('El servidor respondió ' + response.status + '.');
      const type = response.headers.get('content-type') || '';
      if (type && !type.startsWith('video/') && !type.includes('octet-stream')) throw new Error('El enlace no devuelve un archivo de vídeo.');
      const blob = await response.blob();
      if (!blob.size) throw new Error('El archivo está vacío.');
      const ext = url.pathname.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
      const file = new File([blob], 'video-enlace.' + ext, { type: type || 'video/mp4' });
      preview.style.display = 'none';
      load(file);
      note.textContent = 'Vídeo cargado (' + (blob.size / 1024 / 1024).toFixed(1) + ' MB). Ya puedes buscar clips.';
    } catch (error) {
      note.textContent = 'No se pudo cargar el enlace: ' + error.message + ' El sitio puede bloquear CORS o exigir inicio de sesión. Descarga el archivo desde una fuente autorizada y selecciónalo arriba.';
    } finally { button.disabled = false; }
  };

  // Avoid stale preview state after a failed seek; keep errors visible to the user.
  const oldExportClip = exportClip;
  exportClip = async function(clip) {
    try { return await oldExportClip(clip); }
    catch (error) { log('No se pudo exportar este clip: ' + (error.message || error)); }
  };
})();
