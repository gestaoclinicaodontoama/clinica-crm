import { AvaliacaoApp } from './state.js';
import { get, post, patch, postFile } from './api.js';
import { showToast, showConsentModal, showModal, closeModal, formatDate } from './ui.js';

const ETAPAS = ['Situação', 'Problema', 'Implicação', 'Necessidade', 'Objeções', 'Compromisso', 'Fechamento', 'Pós-venda'];
const IDB_STORE = 'avaliacao_session';
const IDB_BUFFER_STORE = 'avaliacao_offline_buffer';

let _mode = 'deepgram';
let _ws = null;
let _offlineFlushRegistered = false;
let _stream = null;
let _audioCtx = null;
let _processor = null;
let _reconnectCount = 0;
let _reconnectTimer = null;
let _tokenExpiresAt = null;
let _tokenRenewTimer = null;
let _sessionId = null;
let _transcript = [];
let _analysis = null;
let _uso = null;
let _sessionActive = false;
let _saving = false;
let _feedbackState = {};
let _steps = [];
let _stepsTimer = null;

function uuidv4() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

async function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('avaliacao-dentista', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      if (!db.objectStoreNames.contains(IDB_BUFFER_STORE)) db.createObjectStore(IDB_BUFFER_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(store, key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbSet(store, key, value) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(store, key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function persistSession() {
  const sid = _sessionId;
  if (!sid) return;
  const snapshot = {
    consultaId: sid,
    startedAt: AvaliacaoApp.currentSession?.startedAt,
    mode: _mode,
    transcript: _transcript,
    analysis: _analysis,
    uso: _uso,
  };
  if (_sessionId !== sid) return; // Limpar fired between start and here
  await idbSet(IDB_STORE, 'current', snapshot);
}

function setMicStatus(text) {
  const el = document.getElementById('avd-mic-status');
  if (el) el.textContent = text;
}

function setAudioStatus(active) {
  const el = document.getElementById('avd-audio-status');
  if (el) el.style.display = active ? 'flex' : 'none';
}

// ── Progress steps ───────────────────────────────────────────────────────────

function fmtDur(ms) {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function renderSteps() {
  const el = document.getElementById('avd-progress');
  if (!el) return;
  if (!_steps.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const now = Date.now();
  el.innerHTML = _steps.map((s, i) => {
    const dur = fmtDur((s.endedAt || now) - s.startedAt);
    const isActive = s.status === 'active';
    const isDone = s.status === 'done';
    const isError = s.status === 'error';
    const dotColor = isDone ? 'var(--green)' : isError ? 'var(--red)' : isActive ? 'var(--accent)' : 'var(--border)';
    const textColor = isActive ? 'var(--text)' : isDone || isError ? 'var(--muted)' : 'var(--muted)';
    const durColor = isDone ? 'var(--green)' : isError ? 'var(--red)' : 'var(--accent)';
    const dot = isDone
      ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="${dotColor}"/><path d="M5 8l2 2 4-4" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : isError
      ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="${dotColor}"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>`
      : isActive
      ? `<div style="width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:avd-spin .8s linear infinite;flex-shrink:0"></div>`
      : `<div style="width:16px;height:16px;border:2px solid var(--border);border-radius:50%;flex-shrink:0"></div>`;
    const connector = i < _steps.length - 1
      ? `<div style="width:2px;height:10px;background:${isDone ? 'var(--green)' : 'var(--border)'};margin:2px 0 2px 7px"></div>`
      : '';
    return `<div>
      <div style="display:flex;align-items:center;gap:10px">
        ${dot}
        <span style="font-size:13px;font-weight:${isActive ? '600' : '400'};color:${textColor};flex:1">${s.label}</span>
        ${isActive || isDone || isError ? `<span style="font-size:12px;font-family:'DM Mono',monospace;color:${durColor}">${dur}</span>` : ''}
      </div>
      ${connector}
    </div>`;
  }).join('');
}

function startStep(label) {
  if (_steps.length > 0) {
    const prev = _steps[_steps.length - 1];
    if (prev.status === 'active') { prev.status = 'done'; prev.endedAt = Date.now(); }
  }
  _steps.push({ label, startedAt: Date.now(), endedAt: null, status: 'active' });
  if (!_stepsTimer) _stepsTimer = setInterval(renderSteps, 500);
  renderSteps();
}

function completeLastStep(error = false) {
  if (_steps.length > 0) {
    const s = _steps[_steps.length - 1];
    s.status = error ? 'error' : 'done';
    s.endedAt = Date.now();
  }
  if (error || _steps.every(s => s.status !== 'active')) {
    clearInterval(_stepsTimer); _stepsTimer = null;
  }
  renderSteps();
}

function clearSteps() {
  clearInterval(_stepsTimer); _stepsTimer = null;
  _steps = [];
  renderSteps();
}

function appendTurnToUI(turn) {
  const container = document.getElementById('avd-transcript');
  if (!container) return;
  const div = document.createElement('div');
  const cls = turn.speaker_label === 'DENTISTA' ? 'avd-turn-dentista'
    : turn.speaker_label === 'PACIENTE' ? 'avd-turn-paciente' : 'avd-turn-voz';
  div.className = `avd-turn ${cls}`;
  div.innerHTML = `<span class="avd-turn-who">${turn.speaker_label}</span>${escHtml(turn.text)}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function float32ToInt16(buffer) {
  const out = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const s = Math.max(-1, Math.min(1, buffer[i]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out.buffer;
}

async function requestDeepgramToken() {
  const data = await post('/avaliacoes/deepgram-token');
  _tokenExpiresAt = new Date(data.expires_at).getTime();
  scheduleTokenRenewal();
  return data.token;
}

function scheduleTokenRenewal() {
  clearTimeout(_tokenRenewTimer);
  if (!_tokenExpiresAt) return;
  const now = Date.now();
  const ttl = _tokenExpiresAt - now;
  const renewAt = ttl * 0.8;
  if (renewAt <= 0) return;
  _tokenRenewTimer = setTimeout(async () => {
    if (!_sessionActive || _mode !== 'deepgram') return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await requestDeepgramToken();
        reconnectDeepgramWithToken(token);
        return;
      } catch (e) {
        if (attempt === 1) {
          showToast('Falha ao renovar token Deepgram. Gravação encerrada.', 'error');
          stopAudio();
          _sessionActive = false;
          setMicStatus('Erro — reinicie a sessão');
        }
      }
    }
  }, renewAt);
}

function reconnectDeepgramWithToken(token) {
  if (_ws) { _ws.onclose = null; _ws.close(); _ws = null; }
  connectDeepgram(token);
}

function connectDeepgram(token) {
  _ws = new WebSocket(
    `wss://api.deepgram.com/v1/listen` +
    `?model=nova-2&language=pt-BR&diarize=true&punctuate=true` +
    `&interim_results=true&smart_format=true` +
    `&encoding=linear16&sample_rate=16000` +
    `&token=${token}`
  );
  _ws.onopen = () => {
    _reconnectCount = 0;
    setMicStatus('Gravando...');
    updateBtn('avd-btn-iniciar', true);
    updateBtn('avd-btn-finalizar', false);
  };
  _ws.onmessage = e => {
    try { handleDeepgramMessage(JSON.parse(e.data)); } catch (_) {}
  };
  _ws.onclose = () => {
    if (!_sessionActive) return;
    handleReconnect(token);
  };
  _ws.onerror = () => {};
}

function handleDeepgramMessage(msg) {
  if (!msg.channel) return;
  const alt = msg.channel.alternatives?.[0];
  const text = alt?.transcript?.trim();
  if (!text) return;
  const words = alt?.words ?? [];
  const speakerId = words.length > 0 ? (words[0].speaker ?? null) : null;
  const label = speakerId === 0 ? 'DENTISTA' : speakerId === 1 ? 'PACIENTE' : 'Voz';

  if (msg.is_final) {
    const turn = { speaker_label: label, text, ts: Date.now() };
    _transcript.push(turn);
    appendTurnToUI(turn);
    const interim = document.getElementById('avd-interim');
    if (interim) interim.textContent = '';
    persistSession().catch(() => {});
    updateBtn('avd-btn-finalizar', false);
  } else {
    const interim = document.getElementById('avd-interim');
    if (interim) interim.textContent = text;
  }
}

function handleReconnect(token) {
  _reconnectCount++;
  if (_reconnectCount > 3) {
    _sessionActive = false;
    setMicStatus('Desconectado');
    showToast('Conexão perdida após 3 tentativas. Você pode continuar via upload.', 'warning');
    renderOfflineOffer();
    return;
  }
  const delay = [1000, 3000, 9000][_reconnectCount - 1] ?? 9000;
  setMicStatus(`Reconectando (${_reconnectCount}/3)...`);
  _reconnectTimer = setTimeout(() => connectDeepgram(token), delay);
}

function renderOfflineOffer() {
  const root = document.getElementById('avd-offline-offer');
  if (!root) return;
  root.innerHTML = `
    <div style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.4);border-radius:10px;padding:14px 16px;margin-top:14px;font-size:13px">
      Áudio bufferizado localmente.
      <button onclick="window._avdSwitchToUpload()" style="margin-left:10px;padding:4px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg3);color:var(--text);cursor:pointer;font-family:inherit;font-size:12px">Continuar com upload</button>
    </div>`;
  root.style.display = 'block';
}

window._avdSwitchToUpload = () => {
  document.querySelector('[data-mode="audio"]')?.click();
};

async function startAudio() {
  try {
    _stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const msg = e.name === 'NotAllowedError'
      ? 'Permissão de microfone negada. Habilite no navegador.'
      : 'Microfone não encontrado ou em uso por outro programa.';
    showToast(msg, 'error');
    setMicStatus('Sem microfone');
    return false;
  }
  _audioCtx = new AudioContext({ sampleRate: 16000 });
  const source = _audioCtx.createMediaStreamSource(_stream);
  _processor = _audioCtx.createScriptProcessor(4096, 1, 1);
  _processor.onaudioprocess = e => {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
    _ws.send(float32ToInt16(e.inputBuffer.getChannelData(0)));
  };
  source.connect(_processor);
  const gain = _audioCtx.createGain();
  gain.gain.value = 0;
  _processor.connect(gain);
  gain.connect(_audioCtx.destination);
  return true;
}

function stopAudio() {
  clearTimeout(_tokenRenewTimer);
  clearTimeout(_reconnectTimer);
  if (_processor) { _processor.disconnect(); _processor = null; }
  if (_audioCtx) { _audioCtx.close(); _audioCtx = null; }
  if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  if (_ws) { _ws.onclose = null; _ws.close(); _ws = null; }
}

async function checkConsentAndStart(startFn) {
  // NOTE: consent shown here is session-only (not persisted to DB).
  // The copilot operates in unlinked-patient mode (paciente_vinculado=false),
  // so aceitar-consentimento is never called. This is intentional by design.
  const config = AvaliacaoApp.config ?? {};
  const user = AvaliacaoApp.user;

  if (_mode === 'texto') {
    return startFn();
  }

  if (AvaliacaoApp._consentimentoGravacaoAceito) {
    return startFn();
  }

  showConsentModal(
    () => {
      AvaliacaoApp._consentimentoGravacaoAceito = true;
      startFn();
    },
    () => {
      _sessionActive = false;
      _sessionId = null;
      _transcript = [];
      _analysis = null;
      _feedbackState = {};
      AvaliacaoApp.currentSession = null;
      idbDel(IDB_STORE, 'current').catch(() => {});
      showToast('Gravação não autorizada. Você pode usar o modo texto.', 'info');
    }
  );
}

async function handleIniciar() {
  if (_sessionActive) return;
  _sessionActive = true; // set immediately to block double-tap before async consent

  _sessionId = uuidv4();
  _transcript = [];
  _analysis = null;

  AvaliacaoApp.currentSession = {
    consultaId: _sessionId,
    startedAt: new Date().toISOString(),
    mode: _mode,
    transcript: _transcript,
    analysis: null,
  };
  AvaliacaoApp.emit('session:start', { consultaId: _sessionId });

  await persistSession();

  if (_mode === 'deepgram') {
    await checkConsentAndStart(async () => {
      setMicStatus('Iniciando microfone...');
      const ok = await startAudio();
      if (!ok) { _sessionActive = false; _sessionId = null; AvaliacaoApp.currentSession = null; idbDel(IDB_STORE, 'current').catch(() => {}); return; }
      try {
        const token = await requestDeepgramToken();
        _sessionActive = true;
        connectDeepgram(token);
      } catch (e) {
        _sessionActive = false;
        _sessionId = null;
        AvaliacaoApp.currentSession = null;
        idbDel(IDB_STORE, 'current').catch(() => {});
        setMicStatus('Erro ao obter token');
        showToast('Erro ao conectar Deepgram: ' + e.message, 'error');
        stopAudio();
      }
    });
  } else if (_mode === 'audio') {
    await checkConsentAndStart(() => {
      _sessionActive = true;
      setMicStatus('Pronto para upload');
      updateBtn('avd-btn-iniciar', true);
      updateBtn('avd-btn-finalizar', false);
      setAudioStatus(true);
    });
  } else {
    _sessionActive = true;
    setMicStatus('Modo texto');
    updateBtn('avd-btn-iniciar', true);
    updateBtn('avd-btn-finalizar', false);
  }
}

async function handleFinalizar() {
  _sessionActive = false;
  if (_mode === 'deepgram') stopAudio();
  setMicStatus('Finalizando...');
  updateBtn('avd-btn-finalizar', true);
  setAudioStatus(false);

  const mySessionId = _sessionId; // guard: Iniciar can restart session during long upload
  let transcriptFinal = _transcript;

  if (_mode === 'audio') {
    const fileInput = document.getElementById('avd-audio-file');
    if (!fileInput?.files?.[0]) {
      showToast('Selecione um arquivo de áudio antes de finalizar.', 'warning');
      _sessionActive = true;
      setAudioStatus(true);
      updateBtn('avd-btn-finalizar', false);
      return;
    }
    startStep('Submetendo áudio');
    transcriptFinal = await transcribeAudio(fileInput.files[0]);
    if (!transcriptFinal) {
      completeLastStep(true);
      updateBtn('avd-btn-finalizar', false); setAudioStatus(true); return;
    }
    if (_sessionId !== mySessionId) return;
    completeLastStep();
    _transcript = transcriptFinal;
  } else if (_mode === 'texto') {
    const ta = document.getElementById('avd-texto-input');
    const raw = ta?.value?.trim();
    if (!raw) {
      showToast('Cole a transcrição antes de finalizar.', 'warning');
      updateBtn('avd-btn-finalizar', false);
      return;
    }
    transcriptFinal = parseTextTranscript(raw);
    _transcript = transcriptFinal;
  }

  if (!transcriptFinal || transcriptFinal.length === 0) {
    showToast('Nenhuma transcrição disponível.', 'warning');
    updateBtn('avd-btn-finalizar', false);
    return;
  }

  // Persist transcript BEFORE calling Gemini — if analysis fails, user can retry without re-transcribing
  await persistSession();

  await analisarConsulta(transcriptFinal);
}

function parseTextTranscript(raw) {
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const m = line.match(/^(DENTISTA|PACIENTE)\s*:\s*(.+)/i);
    if (m) return { speaker_label: m[1].toUpperCase(), text: m[2].trim(), ts: null };
    return { speaker_label: 'Voz', text: line.trim(), ts: null };
  });
}

async function transcribeAudio(file) {
  startStep('Transcrevendo áudio');
  try {
    const data = await postFile('/avaliacoes/transcrever', file);
    const words = data.words ?? [];
    if (!words.length) {
      completeLastStep(true);
      showToast('Nenhuma fala detectada no áudio.', 'warning');
      return null;
    }
    completeLastStep();
    return buildTurnsFromWords(words);
  } catch (e) {
    completeLastStep(true);
    const msg = e.status === 429
      ? 'Limite de transcrições atingido. Tente novamente em alguns minutos.'
      : 'Erro na transcrição: ' + e.message;
    showToast(msg, 'error');
    return null;
  }
}

function buildTurnsFromWords(words) {
  if (!words.length) return [];
  const turns = [];
  let curr = { speaker: words[0].speaker ?? 0, texts: [] };
  for (const w of words) {
    const sp = w.speaker ?? 0;
    if (sp !== curr.speaker) {
      turns.push({ speaker_label: curr.speaker === 0 ? 'DENTISTA' : 'PACIENTE', text: curr.texts.join(' '), ts: null });
      curr = { speaker: sp, texts: [] };
    }
    curr.texts.push(w.punctuated_word ?? w.word);
  }
  if (curr.texts.length) turns.push({ speaker_label: curr.speaker === 0 ? 'DENTISTA' : 'PACIENTE', text: curr.texts.join(' '), ts: null });
  return turns;
}

async function analisarConsulta(transcript) {
  startStep('Analisando com IA');
  const mySessionId = _sessionId;

  try {
    const result = await post('/avaliacoes/analisar', {
      consulta_id: mySessionId,
      transcript,
      contexto_prompt: AvaliacaoApp.config?.contexto_prompt ?? null,
    });
    completeLastStep();
    if (_sessionId !== mySessionId) return;
    _analysis = result.analysis;
    _uso = result.uso || null;
    if (AvaliacaoApp.currentSession) AvaliacaoApp.currentSession.analysis = _analysis;
    await persistSession();
    clearSteps();
    renderAnalysis(_analysis);
    AvaliacaoApp.emit('session:save', { consultaId: mySessionId, analysis: _analysis });
  } catch (e) {
    completeLastStep(true);
    const isRateLimit = e.status === 429;
    showToast(isRateLimit ? 'Limite mensal de análises atingido.' : 'Falha na análise.', 'error');
    renderAnalysisError(isRateLimit, e.message);
  }
}

function renderAnalysisError(isRateLimit, detail) {
  const zona = document.getElementById('avd-zona3');
  if (!zona) return;
  zona.style.display = 'block';
  if (isRateLimit) {
    zona.innerHTML = `<div style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:10px;padding:16px;font-size:13px;color:var(--red)">Limite mensal atingido. Fale com o gestor.</div>`;
  } else {
    zona.innerHTML = `<div style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:10px;padding:16px;font-size:13px">
      <div style="font-weight:600;margin-bottom:6px">Falha na análise</div>
      ${detail ? `<div style="font-size:12px;color:var(--muted);margin-bottom:10px;font-family:'DM Mono',monospace;word-break:break-all">${escHtml(detail)}</div>` : ''}
      <button onclick="window._avdRetryAnalysis()" style="padding:5px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);cursor:pointer;font-family:inherit;font-size:12px">Tentar análise de novo</button>
      <span style="font-size:11px;color:var(--muted);margin-left:10px">A transcrição foi salva — não precisa re-enviar o áudio.</span>
    </div>`;
    window._avdRetryAnalysis = () => analisarConsulta(_transcript);
  }
}

function renderAnalysis(analysis) {
  const zona = document.getElementById('avd-zona3');
  if (!zona) return;
  zona.style.display = 'block';

  const notaCor = analysis.nota_final >= 7 ? 'var(--green)' : analysis.nota_final >= 5 ? 'var(--yellow)' : 'var(--red)';

  zona.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:22px;margin-bottom:18px">
      <div style="display:flex;align-items:center;gap:18px;margin-bottom:16px;flex-wrap:wrap">
        <div style="font-size:48px;font-weight:700;font-family:'DM Mono',monospace;color:${notaCor}">${analysis.nota_final?.toFixed(1)}</div>
        <div style="flex:1">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">Nota final</div>
          <div style="font-size:14px;line-height:1.5;color:var(--text)">${escHtml(analysis.veredito ?? '')}</div>
        </div>
      </div>
      <div id="avd-etapas">
        ${(analysis.etapas ?? []).map((e, i) => renderEtapa(e, i)).join('')}
      </div>
      <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">
        <button onclick="window._avdSalvar()" style="padding:9px 20px;border-radius:8px;background:var(--green);color:white;border:none;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit" aria-label="Salvar consulta no servidor">Salvar consulta</button>
        <button onclick="window._avdExportarTranscript()" style="padding:9px 16px;border-radius:8px;background:var(--bg3);color:var(--text);border:1px solid var(--border);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit" aria-label="Exportar transcrição em texto">Exportar transcript</button>
      </div>
      <div id="avd-save-status" style="font-size:12px;color:var(--muted);margin-top:10px"></div>
    </div>`;

  window._avdSalvar = handleSalvar;
  window._avdExportarTranscript = () => exportTranscript();
  window._avdFeedback = handleFeedbackEtapa;
  window._avdDetalhar = (idx) => {
    const nome = _analysis?.etapas?.[idx]?.nome;
    import('./coaching.js').then(({ detalharEtapa }) => detalharEtapa(_sessionId, idx, nome)).catch(() => showToast('Erro ao carregar coaching.', 'error'));
  };
}

function renderEtapa(etapa, i) {
  const notaCor = etapa.nota >= 7 ? 'var(--green)' : etapa.nota >= 5 ? 'var(--yellow)' : 'var(--red)';
  const pct = (etapa.nota / 10) * 100;
  return `
    <div style="padding:12px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <span style="font-size:12px;font-family:'DM Mono',monospace;width:110px;flex-shrink:0;color:var(--muted)">${escHtml(etapa.nome)}</span>
        <div style="flex:1;height:6px;background:var(--bg3);border-radius:999px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:${notaCor};border-radius:999px"></div>
        </div>
        <span style="font-family:'DM Mono',monospace;font-size:13px;width:28px;text-align:right;color:${notaCor}">${etapa.nota?.toFixed(1)}</span>
      </div>
      <div style="font-size:12.5px;color:var(--muted);line-height:1.4;margin-bottom:4px">${escHtml(etapa.feedback ?? '')}</div>
      <div style="font-size:12px;color:var(--green);line-height:1.4;margin-bottom:8px">${escHtml(etapa.melhoria ?? '')}</div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span style="font-size:11px;color:var(--muted)">Concordou?</span>
        <button onclick="window._avdFeedback(${i},'sim')" aria-label="Concordo com o feedback da etapa ${escHtml(etapa.nome)}" class="avd-fb-btn" data-etapa="${i}" data-val="sim" style="padding:3px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);cursor:pointer;font-size:13px">✅</button>
        <button onclick="window._avdFeedback(${i},'parcial')" aria-label="Concordo parcialmente com o feedback da etapa ${escHtml(etapa.nome)}" class="avd-fb-btn" data-etapa="${i}" data-val="parcial" style="padding:3px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);cursor:pointer;font-size:13px">⚠️</button>
        <button onclick="window._avdFeedback(${i},'nao')" aria-label="Discordo do feedback da etapa ${escHtml(etapa.nome)}" class="avd-fb-btn" data-etapa="${i}" data-val="nao" style="padding:3px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);cursor:pointer;font-size:13px">❌</button>
        <button onclick="window._avdDetalhar(${i})" aria-label="Detalhar mais a etapa ${escHtml(etapa.nome)}" style="padding:3px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);cursor:pointer;font-size:11px;color:var(--muted);font-family:inherit">Detalhar mais</button>
      </div>
    </div>`;
}

function handleFeedbackEtapa(idx, concordou) {
  _feedbackState[idx] = concordou;
  const btns = document.querySelectorAll(`.avd-fb-btn[data-etapa="${idx}"]`);
  btns.forEach(b => {
    const isActive = b.dataset.val === concordou;
    b.style.background = isActive ? 'var(--accent)' : 'var(--bg3)';
    b.style.color = isActive ? 'white' : 'var(--text)';
    b.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
  });
}

async function handleSalvar() {
  if (!_sessionId || !_analysis) {
    showToast('Análise incompleta.', 'warning');
    return;
  }
  if (_saving) return;
  _saving = true;

  const statusEl = document.getElementById('avd-save-status');
  if (statusEl) statusEl.textContent = 'Salvando...';

  const feedbacks = collectFeedbacks();
  const payload = {
    id: _sessionId,
    modo: _mode,
    started_at: AvaliacaoApp.currentSession?.startedAt,
    ended_at: new Date().toISOString(),
    transcript: _transcript,
    analysis: _analysis,
    feedback_ia: feedbacks,
    paciente_nome: document.getElementById('avd-paciente-nome')?.value?.trim() || 'Paciente sem nome',
    paciente_vinculado: false,
    uso: _uso || null,
  };

  try {
    await post('/avaliacoes', payload);
    if (statusEl) statusEl.textContent = 'Consulta salva com sucesso.';
    showToast('Consulta salva.', 'success');
    await idbDel(IDB_STORE, 'current');
    AvaliacaoApp.emit('consulta:saved', { consultaId: _sessionId });
  } catch (e) {
    if (!navigator.onLine) {
      await idbSet(IDB_BUFFER_STORE, payload.id, { payload, savedAt: Date.now() });
      if (statusEl) statusEl.textContent = 'Salvo localmente (offline). Será enviado ao reconectar.';
      showToast('Sem conexão. Consulta salva localmente.', 'warning');
      if (!_offlineFlushRegistered) { _offlineFlushRegistered = true; setupOfflineFlush(); }
    } else {
      if (statusEl) statusEl.textContent = '';
      showToast('Erro ao salvar: ' + e.message, 'error');
    }
  } finally {
    _saving = false;
  }
}

function collectFeedbacks() {
  if (!_analysis?.etapas) return null;
  const etapas = _analysis.etapas.map((e, i) => {
    const val = _feedbackState[i];
    return val ? { nome: e.nome, concordou: val } : null;
  }).filter(Boolean);
  if (!etapas.length) return null;
  const nota_geral = Math.max(1, Math.min(5, Math.round((_analysis.nota_final ?? 5) / 2)));
  return { schema_version: 1, nota_geral, etapas };
}

function setupOfflineFlush() {
  const handler = async () => {
    _offlineFlushRegistered = false;
    if (!navigator.onLine) return;
    const db = await openIDB();
    const keys = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_BUFFER_STORE, 'readonly');
      const r = tx.objectStore(IDB_BUFFER_STORE).getAllKeys();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (!keys.length) return;

    const confirmSend = confirm(`Você tem ${keys.length} consulta(s) salva(s) offline. Enviar agora?`);
    if (!confirmSend) return;

    for (const key of keys) {
      const item = await idbGet(IDB_BUFFER_STORE, key);
      try {
        await post('/avaliacoes', item.payload);
        await idbDel(IDB_BUFFER_STORE, key);
        showToast('Consulta offline enviada.', 'success');
      } catch (e) {
        if (e.status === 409) {
          await idbDel(IDB_BUFFER_STORE, key); // server already has it — clear
          showToast('Consulta offline já estava salva.', 'info');
        } else {
          showToast('Erro ao enviar consulta offline: ' + e.message, 'error');
        }
      }
    }
  };
  window.addEventListener('online', handler, { once: true });
}

function exportTranscript() {
  const text = _transcript.map(t => `${t.speaker_label}: ${t.text}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `consulta_${_sessionId}_transcript.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function showSpinner(msg) {
  const el = document.getElementById('avd-spinner');
  if (el) { el.style.display = 'flex'; el.querySelector('.avd-spin-msg').textContent = msg; }
}

function hideSpinner() {
  const el = document.getElementById('avd-spinner');
  if (el) el.style.display = 'none';
}

function updateBtn(id, disabled) {
  const el = document.getElementById(id);
  if (el) el.disabled = disabled;
}

function switchMode(mode) {
  _mode = mode;
  ['deepgram', 'audio', 'texto'].forEach(m => {
    const pane = document.getElementById(`avd-pane-${m}`);
    if (pane) pane.style.display = m === mode ? 'block' : 'none';
    const btn = document.querySelector(`[data-mode="${m}"]`);
    if (btn) {
      btn.classList.toggle('active', m === mode);
      btn.setAttribute('aria-selected', m === mode ? 'true' : 'false');
    }
  });
}

function renderRoot() {
  const root = document.getElementById('copiloto-root');
  if (!root) return;

  root.innerHTML = `
<style>
.avd-turn { padding:8px 12px;border-radius:10px;font-size:13.5px;line-height:1.5;max-width:90%;margin-bottom:6px;animation:avd-rise .2s ease }
.avd-turn-who { display:block;font-size:10px;text-transform:uppercase;letter-spacing:.6px;opacity:.6;margin-bottom:2px;font-family:'DM Mono',monospace }
.avd-turn-dentista { background:var(--bg3);border:1px solid var(--border);align-self:flex-start }
.avd-turn-paciente { background:rgba(79,142,247,.08);border:1px solid rgba(79,142,247,.2);align-self:flex-end }
.avd-turn-voz { background:var(--bg3);border:1px solid var(--border);opacity:.7 }
@keyframes avd-rise { from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none} }
.avd-mode-tab { padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--muted);cursor:pointer;font-size:12.5px;font-weight:500;font-family:inherit;transition:all .15s }
.avd-mode-tab.active { background:var(--accent);color:white;border-color:var(--accent) }
</style>
<div style="margin-bottom:16px">
  <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Modo de entrada:</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap" role="tablist" aria-label="Modo de entrada">
    <button class="avd-mode-tab active" data-mode="deepgram" aria-selected="true" role="tab" onclick="window._avdMode('deepgram')">Microfone ao vivo</button>
    <button class="avd-mode-tab" data-mode="audio" aria-selected="false" role="tab" onclick="window._avdMode('audio')">Upload de áudio</button>
    <button class="avd-mode-tab" data-mode="texto" aria-selected="false" role="tab" onclick="window._avdMode('texto')">Colar texto</button>
  </div>
</div>

<div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:14px">
  <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px">Nome do paciente</label>
  <input id="avd-paciente-nome" placeholder="Paciente sem nome" style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;font-family:inherit;width:280px">
</div>

<div id="avd-pane-deepgram" style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:14px">
  <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Transcrição ao vivo</div>
  <div id="avd-transcript" style="min-height:180px;max-height:360px;overflow-y:auto;display:flex;flex-direction:column;padding-right:4px;gap:4px;margin-bottom:8px"></div>
  <div id="avd-interim" style="font-size:13px;font-style:italic;color:var(--muted);min-height:20px;padding:4px 0"></div>
  <div
    id="avd-mic-status"
    aria-live="polite"
    aria-label="Status do microfone"
    style="font-size:11.5px;color:var(--muted);font-family:'DM Mono',monospace;margin-top:6px"
  >Aguardando</div>
</div>

<div id="avd-pane-audio" style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:14px;display:none">
  <div id="avd-audio-status" style="display:none;align-items:center;gap:8px;padding:10px 14px;border-radius:8px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);margin-bottom:12px;font-size:13px;color:var(--green);font-weight:500">
    <div style="width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;animation:avd-pulse 1.5s ease infinite"></div>
    Sessão iniciada — selecione o arquivo e clique em "Finalizar e analisar"
  </div>
  <style>@keyframes avd-pulse{0%,100%{opacity:1}50%{opacity:.4}}</style>
  <div style="font-size:12px;color:var(--muted);margin-bottom:10px">Formatos aceitos: MP3, WAV, M4A, FLAC, OGG, MP4, WebM — até 500MB</div>
  <input type="file" id="avd-audio-file" accept="audio/*,video/mp4,video/webm" style="margin-bottom:12px">
</div>

<div id="avd-pane-texto" style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:14px;display:none">
  <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Cole a transcrição. Formato: <code style="color:var(--accent)">DENTISTA: texto</code> ou <code style="color:var(--accent)">PACIENTE: texto</code></div>
  <textarea id="avd-texto-input" style="width:100%;min-height:220px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'DM Mono',monospace;font-size:12.5px;padding:10px;resize:vertical" placeholder="DENTISTA: Olá, como está se sentindo hoje?&#10;PACIENTE: Tenho uma dor aqui..."></textarea>
</div>

<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
  <button id="avd-btn-iniciar" onclick="window._avdIniciar()" style="padding:9px 20px;border-radius:8px;background:var(--accent);color:white;border:none;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit" aria-label="Iniciar consulta">Iniciar</button>
  <button id="avd-btn-finalizar" onclick="window._avdFinalizar()" disabled style="padding:9px 20px;border-radius:8px;background:var(--bg3);color:var(--text);border:1px solid var(--border);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit" aria-label="Finalizar consulta e analisar">Finalizar e analisar</button>
  <button onclick="window._avdLimpar()" style="padding:9px 16px;border-radius:8px;background:var(--bg3);color:var(--muted);border:1px solid var(--border);font-size:13px;cursor:pointer;font-family:inherit" aria-label="Limpar sessão atual">Limpar</button>
</div>

<style>@keyframes avd-spin{to{transform:rotate(360deg)}}</style>
<div id="avd-progress" style="display:none;background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:14px"></div>

<div id="avd-zona3" style="display:none"></div>
<div id="avd-offline-offer" style="display:none"></div>
`;

  window._avdMode = switchMode;
  window._avdIniciar = handleIniciar;
  window._avdFinalizar = handleFinalizar;
  window._avdLimpar = () => {
    _sessionActive = false;
    _saving = false;
    stopAudio();
    _transcript = [];
    _analysis = null;
    _uso = null;
    _sessionId = null;
    _reconnectCount = 0;
    AvaliacaoApp.currentSession = null;
    AvaliacaoApp._consentimentoGravacaoAceito = false;
    _feedbackState = {};
    idbDel(IDB_STORE, 'current').catch(() => {});
    const tc = document.getElementById('avd-transcript');
    if (tc) tc.innerHTML = '';
    const z3 = document.getElementById('avd-zona3');
    if (z3) { z3.style.display = 'none'; z3.innerHTML = ''; }
    setMicStatus('Aguardando');
    setAudioStatus(false);
    clearSteps();
    updateBtn('avd-btn-iniciar', false);
    updateBtn('avd-btn-finalizar', true);
  };
}

export async function init() {
  renderRoot();

  const saved = await idbGet(IDB_STORE, 'current').catch(() => null);
  if (saved && saved.consultaId) {
    const resume = confirm('Existe uma sessão incompleta. Deseja retomá-la?');
    if (resume) {
      _sessionId = saved.consultaId;
      _transcript = saved.transcript ?? [];
      _analysis = saved.analysis;
      _uso = saved.uso ?? null;
      _mode = saved.mode ?? 'deepgram';
      AvaliacaoApp.currentSession = {
        consultaId: _sessionId,
        startedAt: saved.startedAt,
        mode: _mode,
        transcript: _transcript,
        analysis: _analysis,
      };
      switchMode(_mode);
      if (!_analysis) {
        _sessionActive = true;
        if (saved.transcript?.length) {
          updateBtn('avd-btn-finalizar', false);
          // Transcript recovered from IDB — offer retry without re-transcribing
          if (_mode === 'audio' || _mode === 'texto') {
            const zona = document.getElementById('avd-zona3');
            if (zona) {
              zona.style.display = 'block';
              zona.innerHTML = `<div style="background:rgba(79,142,247,.08);border:1px solid rgba(79,142,247,.25);border-radius:10px;padding:14px 16px;font-size:13px">
                Sessão recuperada com transcrição salva.
                <button onclick="window._avdRetryAnalysis()" style="margin-left:10px;padding:5px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg3);cursor:pointer;font-family:inherit;font-size:12px">Analisar agora</button>
              </div>`;
              window._avdRetryAnalysis = () => analisarConsulta(_transcript);
            }
          }
        }
      }
      if (saved.transcript?.length) {
        saved.transcript.forEach(t => appendTurnToUI(t));
      }
      if (_analysis) renderAnalysis(_analysis);
    } else {
      await idbDel(IDB_STORE, 'current').catch(() => {});
    }
  }

  if (!_offlineFlushRegistered) {
    _offlineFlushRegistered = true;
    setupOfflineFlush();
  }
}
