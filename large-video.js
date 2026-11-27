/* ClipForge large-media + intelligent framing improvements.
   Runs locally in the browser; no video upload or processing server. */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const oldGetAudio = getAudio;

  // Decode the audio track through the browser's streaming media pipeline.
  // This avoids file.arrayBuffer() + decodeAudioData() on multi-GB source files.
  getAudio = async function(file) {
    const capture = vid.captureStream || vid.mozCaptureStream;
    if (!capture) {
      if (file.size > 250 * 1024 * 1024) {
        throw new Error('Este navegador no permite leer el audio por streaming. Usa Chrome o Edge actualizado para procesar archivos grandes.');
      }
      return oldGetAudio(file);
    }

    const oldTime = vid.currentTime || 0;
    const oldVolume = vid.volume;
    let stream, audioContext, source, processor, silent, timeoutId;
    try {
      stream = capture.call(vid);
      const tracks = stream.getAudioTracks();
      if (!tracks.length) {
        stream.getTracks().forEach(t => t.stop());
        if (file.size > 250 * 1024 * 1024) throw new Error('El vídeo no contiene una pista de audio compatible.');
        return oldGetAudio(file);
      }

      audioContext = new AudioContext({ sampleRate: 16000 });
      await audioContext.resume();
      const rate = audioContext.sampleRate;
      const duration = Number.isFinite(vid.duration) ? vid.duration : 0;
      const bytesNeeded = Math.ceil((duration + 1) * rate) * 4;
      const deviceRam = (navigator.deviceMemory || 4) * 1024 ** 3;
      if (bytesNeeded > deviceRam * 0.16) {
        throw new Error('Este vídeo necesita demasiada memoria para analizarse de una vez. Prueba a dividirlo en partes de 30–45 minutos.');
      }
      const mono = new Float32Array(Math.ceil((duration + 1) * rate));
      let written = 0;
      source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(8192, 2, 1);
      silent = audioContext.createGain();
      silent.gain.value = 0;
      processor.onaudioprocess = event => {
        const input = event.inputBuffer;
        const left = input.getChannelData(0);
        const right = input.numberOfChannels > 1 ? input.getChannelData(1) : left;
        const count = Math.min(left.length, mono.length - written);
        for (let i = 0; i < count; i++) mono[written + i] = (left[i] + right[i]) * 0.5;
        written += count;
      };
      source.connect(processor);
      processor.connect(silent);
      silent.connect(audioContext.destination);

      vid.pause();
      vid.volume = 0;
      await seek(0);
      log('Leyendo el audio por streaming en el navegador…');
      const ended = new Promise((resolve, reject) => {
        const done = () => resolve();
        const failed = () => reject(new Error('El navegador detuvo la lectura del vídeo.'));
        vid.addEventListener('ended', done, { once: true });
        vid.addEventListener('error', failed, { once: true });
        timeoutId = setTimeout(() => reject(new Error('La lectura del vídeo tardó demasiado. Prueba con un archivo más corto.')), Math.max(120000, (duration + 90) * 1000));
      });
      await vid.play();
      const progress = () => {
        if (!vid.paused && duration) {
          log('Leyendo audio… ' + fmt(vid.currentTime) + ' / ' + fmt(duration) + ' · no cierres esta pestaña');
          prog(8 + 68 * Math.min(1, vid.currentTime / duration));
          requestAnimationFrame(progress);
        }
      };
      requestAnimationFrame(progress);
      await ended;
      const used = Math.min(written, mono.length);
      const samples = mono.subarray(0, used);
      const audioBufferLike = {
        sampleRate: rate,
        length: used,
        numberOfChannels: 1,
        getChannelData: () => samples
      };
      return { mono: samples, ab: audioBufferLike };
    } catch (error) {
      // Do not silently fall back to a multi-gigabyte allocation.
      if (file.size > 250 * 1024 * 1024 || /memoria|streaming|dividir/i.test(error.message || '')) throw error;
      console.warn('Streaming de audio no disponible; usando decodificación clásica.', error);
      return oldGetAudio(file);
    } finally {
      clearTimeout(timeoutId);
      try { vid.pause(); } catch {}
      try { vid.volume = oldVolume; } catch {}
      try { if (processor) { processor.disconnect(); processor.onaudioprocess = null; } } catch {}
      try { source?.disconnect(); silent?.disconnect(); } catch {}
      try { stream?.getTracks().forEach(t => t.stop()); } catch {}
      try { await audioContext?.close(); } catch {}
      try { await seek(Math.min(oldTime, Math.max(0, (vid.duration || 1) - .1))); } catch {}
    }
  };

  // Give users an honest estimate and remove the misleading one-hour / small-file hint.
  const info = $('#info');
  const originalLoad = load;
  load = function(file) {
    originalLoad(file);
    if (!file) return;
    const size = file.size;
    const pretty = size >= 1024 ** 3
      ? (size / 1024 ** 3).toFixed(2) + ' GB'
      : (size / 1024 ** 2).toFixed(0) + ' MB';
    const note = document.createElement('div');
    note.id = 'large-file-note';
    note.style.cssText = 'margin-top:8px;padding:9px 11px;border:1px solid #d5dae5;border-radius:5px;background:#f7f8fb;color:#39445a;font-size:12px';
    note.textContent = size > 250 * 1024 ** 2
      ? 'Archivo grande (' + pretty + '). Se leerá el audio progresivamente en tu navegador; el análisis puede tardar tanto como la duración del vídeo. El archivo no se sube.'
      : 'Archivo: ' + pretty + '. El vídeo se procesa localmente en este dispositivo.';
    $('#large-file-note')?.remove();
    info?.after(note);
  };
  $('#drop span').textContent = 'MP4, MOV, WebM · también archivos de varios GB (según memoria y navegador)';
  $('#trk option[value="1"]').textContent = 'Seguir la cara principal (IA local)';
  const hint = document.createElement('p');
  hint.textContent = 'El encuadre automático detecta caras en el dispositivo y mantiene la cara principal dentro del recorte vertical. Si no encuentra una cara, usa el seguimiento visual básico.';
  hint.style.cssText = 'font-size:11px;color:#6a7388;margin:5px 0 0';
  $('#trk').parentElement.append(hint);

  // Face detection improves on skin-colour-only tracking. The original tracker
  // remains the fallback if the model cannot load or no face is visible.
  const fallbackAnalyze = analyze;
  let faceDetectorPromise;
  async function getFaceDetector() {
    if (!faceDetectorPromise) faceDetectorPromise = (async () => {
      const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm');
      const files = await vision.FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );
      try {
        return await vision.FaceDetector.createFromOptions(files, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
            delegate: 'GPU'
          },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.45
        });
      } catch {
        return vision.FaceDetector.createFromOptions(files, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
          },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.45
        });
      }
    })();
    return faceDetectorPromise;
  }

  analyze = async function(clip) {
    if ($('#trk').value === '0' || !vid.videoWidth || vid.videoHeight >= vid.videoWidth) {
      return fallbackAnalyze(clip);
    }
    try {
      const detector = await getFaceDetector();
      const points = [];
      const step = clip.e - clip.s > 1800 ? 1.2 : 0.55;
      const total = Math.max(1, Math.ceil((clip.e - clip.s) / step));
      for (let i = 0, t = clip.s; t < clip.e; i++, t += step) {
        await seek(t);
        const result = detector.detectForVideo(vid, Math.round(t * 1000));
        const faces = result.detections || [];
        if (faces.length) {
          const ranked = faces.map(face => {
            const b = face.boundingBox;
            const x = (b.originX + b.width / 2) / vid.videoWidth;
            const y = (b.originY + b.height / 2) / vid.videoHeight;
            const area = (b.width * b.height) / (vid.videoWidth * vid.videoHeight);
            const centerBias = 1 - Math.min(1, Math.abs(x - .5) * 1.2);
            return { x, y, score: area * (0.65 + centerBias * .35) };
          }).sort((a, b) => b.score - a.score);
          points.push({ t, x: ranked[0].x, y: ranked[0].y });
        } else {
          points.push({ t, x: null, y: null });
        }
        if (i % 5 === 0) {
          log('Detectando caras para el encuadre… ' + Math.round((i + 1) / total * 100) + '%');
          await tick();
        }
      }
      const valid = points.filter(p => p.x !== null);
      if (valid.length < Math.max(2, points.length * .12)) {
        detector.close?.();
        return fallbackAnalyze(clip);
      }
      // Fill gaps with the nearest observation, then smooth abrupt jumps.
      let last = valid[0];
      const filled = points.map(p => {
        if (p.x !== null) last = p;
        return { t: p.t, x: last.x, y: last.y };
      });
      const smooth = (key, i) => {
        const values = filled.slice(Math.max(0, i - 2), Math.min(filled.length, i + 3))
          .map(p => p[key]).sort((a, b) => a - b);
        return values[Math.floor(values.length / 2)];
      };
      clip.fp = filled.map((p, i) => ({ t: p.t, x: smooth('x', i), y: smooth('y', i) }));
      clip.zs = 1;
      detector.close?.();
    } catch (error) {
      console.warn('Detección facial no disponible; se usa el seguimiento básico.', error);
      return fallbackAnalyze(clip);
    }
  };

  // Keep the preview canvas in the selected aspect ratio (the old handler used 16:9).
  const res = $('#res');
  const setResolution = () => {
    const w = +res.value;
    cv.width = w;
    cv.height = Math.round(w * 16 / 9);
  };
  res.removeEventListener?.('change', setResolution);
  res.addEventListener('change', setResolution);
  setResolution();
})();
