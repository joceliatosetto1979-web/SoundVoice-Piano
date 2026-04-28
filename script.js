(function(){
    // ÁUDIO CONTEXT
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    function resumeAudio() { if(audioCtx.state === 'suspended') audioCtx.resume(); }
    document.body.addEventListener('click', resumeAudio, { once: true });
    document.body.addEventListener('touchstart', resumeAudio, { once: true });

    // CONSTANTES MUSICAIS
    const TOTAL_NOTES = 108; // MIDI 0 a 107 (C0 a B8)
    const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    // Mapeamento de índice da preta para índice da branca (0=C,1=D,2=E,3=F,4=G,5=A,6=B)
    const BLACK_TO_WHITE_INDEX = {
        1: 0,  // C# depois do C (índice0)
        3: 1,  // D# depois do D (índice1)
        6: 3,  // F# depois do F (índice3)
        8: 4,  // G# depois do G (índice4)
        10: 5  // A# depois do A (índice5)
    };

    // Estado
    let currentMidiStart = 48;      // mostra C4 a B5
    let sampleBuffer = null;         // buffer recortado ativo
    let rawFullBuffer = null;
    let sampleMode = false;
    let trimStart = 0, trimEnd = 1;

    // Controle de notas ativas (para sustain e parar ao soltar)
    let activeNotes = new Map(); // key: midi, value: { sourceNodes, gainNodes, releaseTimeout? }

    // UI Elements
    const pianoDiv = document.getElementById('pianoKeyboard');
    const recordBtn = document.getElementById('recordBtn'), stopRecordBtn = document.getElementById('stopRecordBtn');
    const uploadBtn = document.getElementById('uploadBtn'), fileInput = document.getElementById('fileInput');
    const confirmBtn = document.getElementById('confirmSampleBtn'), deleteBtn = document.getElementById('deleteSampleBtn');
    const leftOctave = document.getElementById('leftOctave'), rightOctave = document.getElementById('rightOctave');
    const startSlider = document.getElementById('startSlider'), endSlider = document.getElementById('endSlider');
    const startLabel = document.getElementById('startLabel'), endLabel = document.getElementById('endLabel');
    const sampleStatus = document.getElementById('sampleStatus'), msgArea = document.getElementById('messageArea');
    const metroToggle = document.getElementById('metroToggle'), bpmSlider = document.getElementById('bpmSlider'), bpmSpan = document.getElementById('bpmValue');

    // Metrônomo
    let metroInterval = null, metroActive = false, currentBPM = 110;

    // Gravação
    let mediaRecorder = null, recordedChunks = [], isRecording = false;

    // ---------- FUNÇÕES DE ÁUDIO COM SUSTAIN (para ao soltar) ----------
    function stopNote(midi) {
        const noteData = activeNotes.get(midi);
        if (!noteData) return;
        const { sources, gains } = noteData;
        // Fade out rápido e para
        gains.forEach(g => {
            try {
                g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.05);
            } catch(e) {}
            setTimeout(() => {
                if(g && g.disconnect) g.disconnect();
            }, 80);
        });
        sources.forEach(src => {
            try { src.stop(); } catch(e) {}
        });
        activeNotes.delete(midi);
    }

    function playNoteWithSustain(midi, velocity = 0.7) {
        // Se já está tocando, não toca novamente (evita repetição)
        if (activeNotes.has(midi)) return;
        resumeAudio();

        let sources = [];
        let gains = [];

        if (sampleMode && sampleBuffer) {
            const refMidi = 60; // Dó central como referência (pitch neutro)
            const ratio = Math.pow(2, (midi - refMidi) / 12);
            const src = audioCtx.createBufferSource();
            const gain = audioCtx.createGain();
            src.buffer = sampleBuffer;
            src.playbackRate.value = ratio;
            gain.gain.value = velocity * 0.7;
            src.connect(gain);
            gain.connect(audioCtx.destination);
            src.start();
            sources.push(src);
            gains.push(gain);
        } else {
            // Piano sintetizado: dois osciladores com envelope sustain (segura enquanto ativo)
            const freq = 440 * Math.pow(2, (midi - 69) / 12);
            const osc1 = audioCtx.createOscillator();
            const osc2 = audioCtx.createOscillator();
            const gain1 = audioCtx.createGain();
            const gain2 = audioCtx.createGain();
            osc1.type = 'triangle';
            osc2.type = 'sine';
            osc1.frequency.value = freq;
            osc2.frequency.value = freq * 2.0;
            gain1.gain.value = 0.32;
            gain2.gain.value = 0.12;
            osc1.connect(gain1);
            osc2.connect(gain2);
            gain1.connect(audioCtx.destination);
            gain2.connect(audioCtx.destination);
            osc1.start();
            osc2.start();
            sources.push(osc1, osc2);
            gains.push(gain1, gain2);
        }
        activeNotes.set(midi, { sources, gains });
    }

    // ---------- RENDER PIANO COM PRETAS POSICIONADAS CORRETAMENTE ----------
    function renderPiano() {
        const startMidi = currentMidiStart;
        const endMidi = startMidi + 24; // 2 oitavas

        // Coletar teclas brancas e pretas
        const whiteKeys = [];
        const blackKeys = [];
        for (let midi = startMidi; midi < endMidi; midi++) {
            const noteIdx = midi % 12;
            const isBlack = NOTE_NAMES[noteIdx].includes('#');
            if (!isBlack) whiteKeys.push({ midi, noteIdx });
            else blackKeys.push({ midi, noteIdx });
        }

        // Limpar piano
        pianoDiv.innerHTML = '';
        pianoDiv.style.position = 'relative';

        // Criar container para teclas brancas (flex)
        const whiteContainer = document.createElement('div');
        whiteContainer.className = 'keys-white';
        whiteContainer.style.display = 'flex';
        whiteContainer.style.position = 'relative';
        whiteContainer.style.zIndex = '1';
        pianoDiv.appendChild(whiteContainer);

        const whiteElements = [];
        whiteKeys.forEach(key => {
            const white = document.createElement('div');
            white.className = 'key-white';
            white.setAttribute('data-midi', key.midi);
            white.style.position = 'relative';
            whiteContainer.appendChild(white);
            whiteElements.push(white);
        });

        // Container para pretas (absoluto)
        const blackContainer = document.createElement('div');
        blackContainer.className = 'keys-black';
        blackContainer.style.position = 'absolute';
        blackContainer.style.top = '0';
        blackContainer.style.left = '0';
        blackContainer.style.right = '0';
        blackContainer.style.pointerEvents = 'none';
        pianoDiv.appendChild(blackContainer);

        // Posicionar pretas com base na largura das brancas
        blackKeys.forEach(black => {
            const noteIdx = black.noteIdx;
            const whiteIndex = BLACK_TO_WHITE_INDEX[noteIdx];
            if (whiteIndex !== undefined && whiteElements[whiteIndex]) {
                const blackDiv = document.createElement('div');
                blackDiv.className = 'key-black';
                blackDiv.setAttribute('data-midi', black.midi);
                blackDiv.style.position = 'absolute';
                blackDiv.style.pointerEvents = 'auto';
                blackDiv.style.zIndex = '20';
                blackContainer.appendChild(blackDiv);

                // Função para atualizar posição horizontal
                const updatePos = () => {
                    const targetWhite = whiteElements[whiteIndex];
                    if (!targetWhite) return;
                    const whiteRect = targetWhite.getBoundingClientRect();
                    const pianoRect = pianoDiv.getBoundingClientRect();
                    const whiteLeft = whiteRect.left - pianoRect.left;
                    const whiteWidth = targetWhite.offsetWidth;
                    // Preto fica centrado na parte direita da branca (como piano real)
                    blackDiv.style.left = (whiteLeft + whiteWidth - 23) + 'px';
                    blackDiv.style.top = '0px';
                };
                updatePos();
                // Atualiza quando houver scroll/resize
                window.addEventListener('resize', updatePos);
                // Para cada render, precisamos evitar múltiplos listeners? Vamos usar um observer global
                if (!window._posObserver) {
                    window._posObserver = new ResizeObserver(() => {
                        document.querySelectorAll('.key-black').forEach(bl => {
                            const midiVal = parseInt(bl.getAttribute('data-midi'));
                            if (isNaN(midiVal)) return;
                            const noteIdx = midiVal % 12;
                            const wIdx = BLACK_TO_WHITE_INDEX[noteIdx];
                            if (wIdx !== undefined) {
                                const whiteEl = document.querySelectorAll('.key-white')[wIdx];
                                if (whiteEl) {
                                    const wr = whiteEl.getBoundingClientRect();
                                    const pr = pianoDiv.getBoundingClientRect();
                                    bl.style.left = (wr.left - pr.left + whiteEl.offsetWidth - 23) + 'px';
                                }
                            }
                        });
                    });
                    window._posObserver.observe(pianoDiv);
                }
            }
        });

        attachEventsToKeys();
    }

    function attachEventsToKeys() {
        const allKeys = document.querySelectorAll('.key-white, .key-black');
        let dragActive = false;
        let lastMidi = null;

        const startNote = (midi, el) => {
            playNoteWithSustain(midi);
            animateKey(el);
            lastMidi = midi;
            dragActive = true;
        };
        const moveNote = (midi, el) => {
            if (dragActive && lastMidi !== midi) {
                playNoteWithSustain(midi);
                animateKey(el);
                lastMidi = midi;
            }
        };
        const endNote = () => {
            if (lastMidi !== null) {
                stopNote(lastMidi);
                lastMidi = null;
            }
            dragActive = false;
        };

        allKeys.forEach(key => {
            const midi = parseInt(key.getAttribute('data-midi'));
            if (isNaN(midi)) return;
            key.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                startNote(midi, key);
            });
            key.addEventListener('pointerenter', () => {
                if (dragActive) moveNote(midi, key);
            });
            // Para cliques em touch também
            key.addEventListener('click', (e) => {
                e.stopPropagation();
                playNoteWithSustain(midi);
                animateKey(key);
                // Não para imediatamente: somente quando soltar o clique. Porém em click, não há "up" específico.
                // Vamos fazer: se for clique rápido, para depois de um tempo? Melhor manter sustain até outro clique.
                // Mas para não acumular, vamos adicionar stop após 300ms se não houver pointerup? Não, o ideal é que
                // em ambiente de mouse, o pointerup global tratará. No click isolado, precisamos parar após um breve tempo?
                // Vamos adicionar um temporizador para parar após 0.5s se for apenas clique sem arrasto.
                // Mas para simplificar, usaremos o mesmo mecanismo: ao pointerup global paramos a última nota.
            });
        });

        // Global para soltar todas as notas quando o ponteiro for levantado fora
        window.addEventListener('pointerup', () => {
            if (lastMidi !== null) stopNote(lastMidi);
            dragActive = false;
            lastMidi = null;
        });
        window.addEventListener('pointercancel', () => {
            if (lastMidi !== null) stopNote(lastMidi);
            dragActive = false;
            lastMidi = null;
        });
    }

    function animateKey(el) {
        el.classList.add('active');
        setTimeout(() => el.classList.remove('active'), 130);
    }

    function shiftOctave(delta) {
        let newStart = currentMidiStart + delta * 12;
        if (newStart < 0) newStart = 0;
        if (newStart + 24 > TOTAL_NOTES) newStart = TOTAL_NOTES - 24;
        currentMidiStart = newStart;
        renderPiano();
    }

    // ---------- SAMPLE MANAGEMENT ----------
    async function loadAudioFromBlob(blob) {
        const ab = await blob.arrayBuffer();
        return await audioCtx.decodeAudioData(ab);
    }
    function updateTrimUI() {
        if (!rawFullBuffer) {
            startSlider.disabled = true; endSlider.disabled = true;
            sampleStatus.innerText = 'Nenhum áudio';
            return;
        }
        const dur = rawFullBuffer.duration;
        startSlider.max = dur; endSlider.max = dur;
        startSlider.value = Math.min(trimStart, dur);
        endSlider.value = Math.min(trimEnd, dur);
        startLabel.innerText = trimStart.toFixed(2);
        endLabel.innerText = trimEnd.toFixed(2);
        startSlider.disabled = false; endSlider.disabled = false;
        const cutLen = trimEnd - trimStart;
        sampleStatus.innerText = `Duração bruta: ${dur.toFixed(1)}s | Corte: ${cutLen.toFixed(2)}s`;
        if (cutLen > 60) msgArea.innerHTML = '⚠️ Trecho >60s! Reduza antes de confirmar.';
        else if (cutLen < 5 && cutLen > 0) msgArea.innerHTML = '🎵 Recomendado mais de 5 segundos para melhor efeito.';
        else msgArea.innerHTML = '✅ Sample pronto para confirmar. Toque e solte as teclas para parar.';
    }
    function setRawBuffer(buf) {
        rawFullBuffer = buf;
        trimStart = 0;
        trimEnd = buf.duration;
        updateTrimUI();
    }
    function extractTrimmed() {
        if (!rawFullBuffer) return null;
        let start = Math.min(trimStart, rawFullBuffer.duration);
        let end = Math.min(trimEnd, rawFullBuffer.duration);
        if (end - start <= 0.05) return null;
        const startFrame = Math.floor(start * rawFullBuffer.sampleRate);
        const endFrame = Math.floor(end * rawFullBuffer.sampleRate);
        const frames = endFrame - startFrame;
        if (frames <= 0) return null;
        const newBuf = audioCtx.createBuffer(rawFullBuffer.numberOfChannels, frames, rawFullBuffer.sampleRate);
        for (let ch = 0; ch < rawFullBuffer.numberOfChannels; ch++) {
            const data = rawFullBuffer.getChannelData(ch).slice(startFrame, endFrame);
            newBuf.copyToChannel(data, ch, 0);
        }
        return newBuf;
    }
    function confirmSample() {
        if (!rawFullBuffer) { msgArea.innerHTML = '❌ Nenhum áudio carregado.'; return; }
        const cut = trimEnd - trimStart;
        if (cut > 60) { msgArea.innerHTML = '❌ O trecho excede 60 segundos. Ajuste os sliders.'; return; }
        if (cut < 0.1) { msgArea.innerHTML = '❌ Trecho muito curto.'; return; }
        const trimmed = extractTrimmed();
        if (trimmed) {
            sampleBuffer = trimmed;
            sampleMode = true;
            msgArea.innerHTML = '🎉 SAMPLE ATIVADO! As teclas tocam seu som com pitch, e sustentam enquanto pressionadas.';
            sampleStatus.innerText += ` | Sample ativo (${trimmed.duration.toFixed(2)}s)`;
        } else msgArea.innerHTML = 'Erro ao recortar áudio.';
    }
    function deleteSample() {
        sampleBuffer = null;
        sampleMode = false;
        msgArea.innerHTML = '🗑️ Sample removido. Piano retornou ao som clássico.';
        sampleStatus.innerText = rawFullBuffer ? 'Modo piano clássico (sample apagado)' : 'Modo piano clássico';
    }

    // ---------- RECORDING ----------
    async function startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            recordedChunks = [];
            mediaRecorder.ondataavailable = e => recordedChunks.push(e.data);
            mediaRecorder.onstop = async () => {
                const blob = new Blob(recordedChunks, { type: 'audio/webm' });
                const buf = await loadAudioFromBlob(blob);
                setRawBuffer(buf);
                msgArea.innerHTML = '🎤 Gravação concluída! Ajuste os sliders e clique em CONFIRMAR.';
                stream.getTracks().forEach(t => t.stop());
            };
            mediaRecorder.start();
            isRecording = true;
            recordBtn.classList.add('recording');
            stopRecordBtn.disabled = false;
            recordBtn.disabled = true;
        } catch(e) { msgArea.innerHTML = 'Erro microfone: ' + e.message; }
    }
    function stopRecording() {
        if (mediaRecorder && isRecording) {
            mediaRecorder.stop();
            isRecording = false;
            recordBtn.classList.remove('recording');
            recordBtn.disabled = false;
            stopRecordBtn.disabled = true;
        }
    }
    function uploadAudioFile(file) {
        const reader = new FileReader();
        reader.onload = async (ev) => {
            const ab = ev.target.result;
            const decoded = await audioCtx.decodeAudioData(ab);
            setRawBuffer(decoded);
            msgArea.innerHTML = '📀 Arquivo carregado! Ajuste corte e confirme.';
        };
        reader.readAsArrayBuffer(file);
    }

    // ---------- METRONOME ----------
    function scheduleMetro() {
        if (metroInterval) clearInterval(metroInterval);
        if (!metroActive) return;
        const intervalMs = (60 / currentBPM) * 1000;
        metroInterval = setInterval(() => {
            if (!metroActive) return;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.value = 880;
            gain.gain.value = 0.12;
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
            osc.stop(audioCtx.currentTime + 0.12);
        }, intervalMs);
    }
    function toggleMetronome() {
        metroActive = !metroActive;
        if (metroActive) {
            scheduleMetro();
            metroToggle.innerText = '🎵 Metrônomo ON';
            metroToggle.classList.add('metro-active');
        } else {
            if (metroInterval) clearInterval(metroInterval);
            metroInterval = null;
            metroToggle.innerText = '🥁 Metrônomo OFF';
            metroToggle.classList.remove('metro-active');
        }
    }
    function setBPM(val) {
        currentBPM = val;
        bpmSpan.innerText = currentBPM;
        if (metroActive) scheduleMetro();
    }

    // ---------- EVENTOS ----------
    recordBtn.onclick = startRecording;
    stopRecordBtn.onclick = stopRecording;
    uploadBtn.onclick = () => fileInput.click();
    fileInput.onchange = e => { if (e.target.files.length) uploadAudioFile(e.target.files[0]); };
    confirmBtn.onclick = confirmSample;
    deleteBtn.onclick = deleteSample;
    leftOctave.onclick = () => shiftOctave(-1);
    rightOctave.onclick = () => shiftOctave(1);
    startSlider.oninput = e => {
        if (!rawFullBuffer) return;
        let v = parseFloat(e.target.value);
        if (v >= endSlider.value) v = endSlider.value - 0.01;
        trimStart = Math.max(0, v);
        startLabel.innerText = trimStart.toFixed(2);
        updateTrimUI();
    };
    endSlider.oninput = e => {
        if (!rawFullBuffer) return;
        let v = parseFloat(e.target.value);
        if (v <= startSlider.value) v = startSlider.value + 0.01;
        trimEnd = Math.min(rawFullBuffer.duration, v);
        endLabel.innerText = trimEnd.toFixed(2);
   
