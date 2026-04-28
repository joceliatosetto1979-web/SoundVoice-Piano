(function(){
    const audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    function resumeAudio() { if(audioCtx.state==='suspended') audioCtx.resume(); }
    document.body.addEventListener('click', resumeAudio, {once:true});
    document.body.addEventListener('touchstart', resumeAudio, {once:true});

    const TOTAL_MIDI_NOTES = 108;
    const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const BLACK_PARENT_MAP = {1:0,3:1,6:3,8:4,10:5};

    let activeVoices = [];
    const MAX_VOICES = 16;
    function releaseVoice(gainNode, osc1, osc2, src){
        let idx = activeVoices.indexOf(gainNode);
        if(idx!==-1) activeVoices.splice(idx,1);
        if(osc1) osc1.stop();
        if(osc2) osc2.stop();
        if(src) src.stop();
        if(gainNode) gainNode.disconnect();
    }
    function manageVoiceLimit(){
        if(activeVoices.length>=MAX_VOICES){
            let oldest = activeVoices.shift();
            if(oldest) oldest.disconnect();
        }
    }

    let currentMidiStart=48, activeSampleBuffer=null, rawFullBuffer=null, sampleMode=false;
    let trimStartSec=0, trimEndSec=1;

    const pianoDiv=document.getElementById('pianoKeyboard');
    const recordBtn=document.getElementById('recordBtn'), stopRecordBtn=document.getElementById('stopRecordBtn');
    const uploadBtn=document.getElementById('uploadBtn'), fileInput=document.getElementById('fileInput');
    const confirmBtn=document.getElementById('confirmSampleBtn'), deleteBtn=document.getElementById('deleteSampleBtn');
    const leftOctave=document.getElementById('leftOctave'), rightOctave=document.getElementById('rightOctave');
    const startSlider=document.getElementById('startSlider'), endSlider=document.getElementById('endSlider');
    const startLabel=document.getElementById('startLabel'), endLabel=document.getElementById('endLabel');
    const sampleStatus=document.getElementById('sampleStatus'), msgArea=document.getElementById('messageArea');
    const metroToggle=document.getElementById('metroToggle'), bpmSlider=document.getElementById('bpmSlider'), bpmSpan=document.getElementById('bpmValue');

    let metroInterval=null, metroActive=false, currentBPM=110;
    let mediaRecorder=null, recordedChunks=[], isRecording=false;

    function getFreq(midi){ return 440*Math.pow(2,(midi-69)/12); }

    function playNote(midi, vel=0.6){
        if(!audioCtx) return;
        resumeAudio();
        manageVoiceLimit();
        if(sampleMode && activeSampleBuffer){
            let ratio = Math.pow(2,(midi-60)/12);
            let src = audioCtx.createBufferSource();
            let gain = audioCtx.createGain();
            gain.gain.value = Math.min(0.75,vel);
            src.buffer = activeSampleBuffer;
            src.playbackRate.value = ratio;
            src.connect(gain);
            gain.connect(audioCtx.destination);
            src.start();
            activeVoices.push(gain);
            src.onended = ()=>releaseVoice(gain,null,null,src);
        } else {
            let freq = getFreq(midi);
            let osc1 = audioCtx.createOscillator();
            let osc2 = audioCtx.createOscillator();
            let gain = audioCtx.createGain();
            let gain2 = audioCtx.createGain();
            osc1.type='triangle'; osc2.type='sine';
            osc1.frequency.value=freq; osc2.frequency.value=freq*2;
            gain.gain.value=0.32; gain2.gain.value=0.12;
            osc1.connect(gain); osc2.connect(gain2);
            gain.connect(audioCtx.destination); gain2.connect(audioCtx.destination);
            osc1.start(); osc2.start();
            activeVoices.push(gain,gain2);
            gain.gain.exponentialRampToValueAtTime(0.0001,audioCtx.currentTime+1.3);
            gain2.gain.exponentialRampToValueAtTime(0.0001,audioCtx.currentTime+0.9);
            setTimeout(()=>releaseVoice(gain,osc1,osc2),1350);
            setTimeout(()=>releaseVoice(gain2,null,null),1000);
        }
    }

    function renderPiano(){
        let start=currentMidiStart, end=start+24;
        let white=[], black=[];
        for(let m=start; m<end; m++){
            let idx=m%12;
            if(NOTE_NAMES[idx].includes('#')) black.push({midi:m,noteIdx:idx});
            else white.push({midi:m,noteIdx:idx});
        }
        pianoDiv.innerHTML='';
        pianoDiv.style.position='relative';
        let whiteEls=[];
        white.forEach(w=>{
            let d=document.createElement('div');
            d.className='key-white';
            d.setAttribute('data-midi',w.midi);
            d.style.position='relative';
            d.style.zIndex='1';
            pianoDiv.appendChild(d);
            whiteEls.push(d);
        });
        black.forEach(b=>{
            let parentIdx=BLACK_PARENT_MAP[b.noteIdx];
            if(parentIdx!==undefined && whiteEls[parentIdx]){
                let bl=document.createElement('div');
                bl.className='key-black';
                bl.setAttribute('data-midi',b.midi);
                bl.style.position='absolute';
                bl.style.top='0px';
                bl.style.zIndex='10';
                let updatePos=()=>{
                    let leftWhite=whiteEls[parentIdx];
                    if(!leftWhite) return;
                    let wr=leftWhite.getBoundingClientRect();
                    let pr=pianoDiv.getBoundingClientRect();
                    bl.style.left=(wr.left-pr.left+leftWhite.offsetWidth-23)+'px';
                };
                updatePos();
                pianoDiv.appendChild(bl);
                if(!window._resizeObserver){
                    window._resizeObserver=new ResizeObserver(()=>{
                        document.querySelectorAll('.key-black').forEach(bk=>{
                            let mm=parseInt(bk.getAttribute('data-midi'));
                            if(isNaN(mm)) return;
                            let ni=mm%12;
                            let pi=BLACK_PARENT_MAP[ni];
                            if(pi!==undefined && whiteEls[pi]){
                                let lw=whiteEls[pi];
                                let wr=lw.getBoundingClientRect();
                                let pr=pianoDiv.getBoundingClientRect();
                                bk.style.left=(wr.left-pr.left+lw.offsetWidth-23)+'px';
                            }
                        });
                    });
                    window._resizeObserver.observe(pianoDiv);
                }
            }
        });
        attachEvents();
    }

    function attachEvents(){
        let drag=false, lastMidi=null;
        let all=document.querySelectorAll('.key-white,.key-black');
        all.forEach(k=>{
            let midi=parseInt(k.getAttribute('data-midi'));
            if(isNaN(midi)) return;
            k.addEventListener('pointerdown',e=>{e.preventDefault(); playNote(midi); animateKey(k); lastMidi=midi; drag=true;});
            k.addEventListener('pointerenter',()=>{ if(drag && lastMidi!==midi){ playNote(midi); animateKey(k); lastMidi=midi; } });
            k.addEventListener('click',e=>{ e.stopPropagation(); playNote(midi); animateKey(k); });
        });
        document.body.addEventListener('pointerup',()=>{ drag=false; lastMidi=null; });
        document.body.addEventListener('pointercancel',()=>{ drag=false; lastMidi=null; });
    }
    function animateKey(el){ el.classList.add('active'); setTimeout(()=>el.classList.remove('active'),130); }

    function shiftOctave(delta){
        let ns=currentMidiStart+delta*12;
        if(ns<0) ns=0;
        if(ns+24>TOTAL_MIDI_NOTES) ns=TOTAL_MIDI_NOTES-24;
        currentMidiStart=ns;
        renderPiano();
    }

    async function loadAudioFromBlob(blob){
        let ab=await blob.arrayBuffer();
        return await audioCtx.decodeAudioData(ab);
    }
    function updateTrimUI(){
        if(!rawFullBuffer){
            startSlider.disabled=true; endSlider.disabled=true;
            sampleStatus.innerText='Nenhum áudio';
            return;
        }
        let dur=rawFullBuffer.duration;
        startSlider.max=dur; endSlider.max=dur;
        startSlider.value=Math.min(trimStartSec,dur);
        endSlider.value=Math.min(trimEndSec,dur);
        startLabel.innerText=trimStartSec.toFixed(2);
        endLabel.innerText=trimEndSec.toFixed(2);
        startSlider.disabled=false; endSlider.disabled=false;
        let cut=trimEndSec-trimStartSec;
        sampleStatus.innerText=`Bruto: ${dur.toFixed(1)}s | Corte: ${cut.toFixed(2)}s`;
        if(cut>60) msgArea.innerHTML='⚠️ Trecho >60s! Reduza.';
        else if(cut<5&&cut>0) msgArea.innerHTML='🎵 Som curto (<5s). Recomendado >5s.';
        else msgArea.innerHTML='✅ Sample pronto para confirmar.';
    }
    function setRawBuffer(buf){
        rawFullBuffer=buf;
        trimStartSec=0; trimEndSec=buf.duration;
        updateTrimUI();
    }
    function extractTrimmed(){
        if(!rawFullBuffer) return null;
        let start=Math.min(trimStartSec,rawFullBuffer.duration);
        let end=Math.min(trimEndSec,rawFullBuffer.duration);
        if(end-start<=0.02) return null;
        let sf=Math.floor(start*rawFullBuffer.sampleRate);
        let ef=Math.floor(end*rawFullBuffer.sampleRate);
        let frames=ef-sf;
        if(frames<=0) return null;
        let nb=audioCtx.createBuffer(rawFullBuffer.numberOfChannels,frames,rawFullBuffer.sampleRate);
        for(let ch=0; ch<rawFullBuffer.numberOfChannels; ch++){
            let data=rawFullBuffer.getChannelData(ch).slice(sf,ef);
            nb.copyToChannel(data,ch,0);
        }
        return nb;
    }
    function confirmSample(){
        if(!rawFullBuffer){ msgArea.innerHTML='❌ Nenhum áudio.'; return; }
        let cut=trimEndSec-trimStartSec;
        if(cut>60){ msgArea.innerHTML='❌ Trecho >60s! Ajuste.'; return; }
        if(cut<0.1){ msgArea.innerHTML='❌ Muito curto.'; return; }
        let trimmed=extractTrimmed();
        if(trimmed){
            activeSampleBuffer=trimmed;
            sampleMode=true;
            msgArea.innerHTML='🎉 SAMPLE ATIVADO! Pitch shift nas teclas.';
            sampleStatus.innerText+=` | Sample ativo (${trimmed.duration.toFixed(2)}s)`;
        } else msgArea.innerHTML='Falha ao recortar.';
    }
    function deleteSample(){
        activeSampleBuffer=null;
        sampleMode=false;
        msgArea.innerHTML='🗑️ Sample removido. Piano clássico.';
        sampleStatus.innerText=rawFullBuffer?'Modo piano (sample apagado)':'Modo piano clássico';
    }

    async function startRecording(){
        try{
            let stream=await navigator.mediaDevices.getUserMedia({audio:true});
            mediaRecorder=new MediaRecorder(stream);
            recordedChunks=[];
            mediaRecorder.ondataavailable=e=>recordedChunks.push(e.data);
            mediaRecorder.onstop=async()=>{
                let blob=new Blob(recordedChunks,{type:'audio/webm'});
                let buf=await loadAudioFromBlob(blob);
                setRawBuffer(buf);
                msgArea.innerHTML='🎤 Gravação concluída! Ajuste e confirme.';
                stream.getTracks().forEach(t=>t.stop());
            };
            mediaRecorder.start();
            isRecording=true;
            recordBtn.classList.add('recording');
            stopRecordBtn.disabled=false;
            recordBtn.disabled=true;
        }catch(e){ msgArea.innerHTML='Erro microfone: '+e.message; }
    }
    function stopRecording(){
        if(mediaRecorder&&isRecording){
            mediaRecorder.stop();
            isRecording=false;
            recordBtn.classList.remove('recording');
            recordBtn.disabled=false;
            stopRecordBtn.disabled=true;
        }
    }
    function uploadAudioFile(file){
        let reader=new FileReader();
        reader.onload=async(ev)=>{
            let ab=ev.target.result;
            let decoded=await audioCtx.decodeAudioData(ab);
            setRawBuffer(decoded);
            msgArea.innerHTML='📀 Arquivo carregado! Ajuste corte e confirme.';
        };
        reader.readAsArrayBuffer(file);
    }

    function scheduleMetro(){
        if(metroInterval) clearInterval(metroInterval);
        if(!metroActive) return;
        let ms=(60/currentBPM)*1000;
        metroInterval=setInterval(()=>{
            if(!metroActive) return;
            let osc=audioCtx.createOscillator();
            let gain=audioCtx.createGain();
            osc.type='sine';
            osc.frequency.value=880;
            gain.gain.value=0.12;
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            gain.gain.exponentialRampToValueAtTime(0.0001,audioCtx.currentTime+0.12);
            osc.stop(audioCtx.currentTime+0.12);
        },ms);
    }
    function toggleMetronome(){
        metroActive=!metroActive;
        if(metroActive){
            scheduleMetro();
            metroToggle.innerText='🎵 Metrônomo ON';
            metroToggle.classList.add('metro-active');
        } else {
            if(metroInterval) clearInterval(metroInterval);
            metroInterval=null;
            metroToggle.innerText='🥁 Metrônomo OFF';
            metroToggle.classList.remove('metro-active');
        }
    }
    function setBPM(val){
        currentBPM=val;
        bpmSpan.innerText=currentBPM;
        if(metroActive) scheduleMetro();
    }

    recordBtn.onclick=startRecording;
    stopRecordBtn.onclick=stopRecording;
    uploadBtn.onclick=()=>fileInput.click();
    fileInput.onchange=e=>{ if(e.target.files.length) uploadAudioFile(e.target.files[0]); };
    confirmBtn.onclick=confirmSample;
    deleteBtn.onclick=deleteSample;
    leftOctave.onclick=()=>shiftOctave(-1);
    rightOctave.onclick=()=>shiftOctave(1);
    startSlider.oninput=e=>{
        if(!rawFullBuffer) return;
        let v=parseFloat(e.target.value);
        if(v>=endSlider.value) v=endSlider.value-0.01;
        trimStartSec=Math.max(0,v);
        startLabel.innerText=trimStartSec.toFixed(2);
        updateTrimUI();
    };
    endSlider.oninput=e=>{
        if(!rawFullBuffer) return;
        let v=parseFloat(e.target.value);
        if(v<=startSlider.value) v=startSlider.value+0.01;
        trimEndSec=Math.min(rawFullBuffer.duration,v);
        endLabel.innerText=trimEndSec.toFixed(2);
        updateTrimUI();
    };
    metroToggle.onclick=toggleMetronome;
    bpmSlider.oninput=e=>setBPM(parseInt(e.target.value));

    renderPiano();
    msgArea.innerHTML='🎹 Piano clássico. Grave/upload e confirme para sample personalizado!';
})();
